/**
 * Study OS V2 - API & Sync Service
 * Gerencia a comunicação assíncrona com o Firebase Realtime Database
 * e a fila de sincronização em nuvem do Notion.
 */

import { FIREBASE_RTDB_URL } from "../core/constants.js";
import { getFirebaseParamAuth, isAdminAutenticado } from "./auth.js";
import { classificarArquivoArtefato } from "../utils/artifactsClassifier.js";

const _cacheConteudoAulaFetched = new Map();
const _promisesHydratacaoAula = new Map();
const CONTEUDO_BROWSER_CACHE_NAME = "studyos-db-conteudo-v1";
let _versaoDbAtual = 0;

/**
 * Detecta se a aplicação está rodando em ambiente de desenvolvimento local
 * (localhost, 127.0.0.1 ou file://). No GitHub Pages / produção online retorna false.
 * @returns {boolean}
 */
export function isAmbienteLocal() {
  if (typeof window === "undefined" || !window.location) return false;
  const proto = String(window.location.protocol || "").toLowerCase();
  const host = String(window.location.hostname || "").toLowerCase();
  return proto === "file:" || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Identifica se um payload de banco corresponde ao template mockup (`db.json` demonstrativo).
 * @param {object | null | undefined} db
 * @returns {boolean}
 */
export function ehDbMockup(db) {
  return Boolean(db && db.id === "template_root_study_os");
}

/**
 * Registra o timestamp (`atualizado_em`) da versão atual do banco para versionar o
 * cache persistente de `/db_conteudo/{aulaId}.json` (economizando banda no Firebase).
 * @param {number} [ts=0]
 */
export function definirVersaoDbAtual(ts = 0) {
  const novoTs = Number(ts) || 0;
  if (_versaoDbAtual && novoTs && novoTs !== _versaoDbAtual) {
    _cacheConteudoAulaFetched.clear();
    _promisesHydratacaoAula.clear();
    if (typeof caches !== "undefined" && typeof caches.delete === "function") {
      caches.delete(CONTEUDO_BROWSER_CACHE_NAME).catch(() => {});
    }
  }
  _versaoDbAtual = novoTs;
}

function montarChaveCacheConteudo(chave) {
  const ver = _versaoDbAtual || "0";
  return `https://studyos-cache.local/db_conteudo/${encodeURIComponent(chave)}?v=${encodeURIComponent(String(ver))}`;
}

async function lerConteudoDoBrowserCache(chave) {
  if (!_versaoDbAtual || typeof caches === "undefined" || typeof caches.open !== "function") {
    return null;
  }
  try {
    const cache = await caches.open(CONTEUDO_BROWSER_CACHE_NAME);
    const match = await cache.match(montarChaveCacheConteudo(chave));
    if (!match) return null;
    const json = await match.json();
    return json && typeof json === "object" ? json : null;
  } catch (_) {
    return null;
  }
}

async function gravarConteudoNoBrowserCache(chave, dados) {
  if (!_versaoDbAtual || !dados || typeof caches === "undefined" || typeof caches.open !== "function" || typeof Response === "undefined") {
    return;
  }
  try {
    const cache = await caches.open(CONTEUDO_BROWSER_CACHE_NAME);
    const resp = new Response(JSON.stringify(dados), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
    await cache.put(montarChaveCacheConteudo(chave), resp);
  } catch (_) {}
}

/**
 * Limpa o cache em memória de conteúdos de aula baixados sob demanda (usado em testes).
 */
export function limparCacheConteudoSobDemanda() {
  _cacheConteudoAulaFetched.clear();
  _promisesHydratacaoAula.clear();
  _versaoDbAtual = 0;
}

/**
 * Tenta carregar o banco de dados local a partir de caminhos conhecidos.
 * Quando `apenasPessoal` for true, busca exclusivamente `db.personal.json`
 * sem nunca cair no template demonstrativo (`db.json`).
 * @param {{ apenasPessoal?: boolean }} [opcoes]
 * @returns {Promise<object | null>}
 */
export async function carregarDbLocal({ apenasPessoal = false } = {}) {
  const candidatos = apenasPessoal
    ? ["./db.personal.json", "db.personal.json"]
    : ["./db.personal.json", "db.personal.json", "./db.json", "db.json", "./data/db.json"];
  for (const caminho of candidatos) {
    try {
      const resp = await fetch(caminho, { cache: "no-store" });
      if (resp.ok) {
        const json = await resp.json();
        if (json && (json.filhos || json.semestres || Array.isArray(json))) {
          return json;
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Consulta apenas os metadados leves de versão (`/db_meta.json`, ~100 bytes) no Firebase RTDB.
 * @returns {Promise<{ atualizado_em?: number, modo?: string } | null>}
 */
export async function carregarDbMetaFirebase() {
  if (!FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) return null;

  try {
    const authParam = getFirebaseParamAuth();
    const url = `${FIREBASE_RTDB_URL.replace(/\/+$/, "")}/db_meta.json${authParam}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (resp.ok) {
      const json = await resp.json();
      if (json && typeof json === "object") {
        return json;
      }
    }
  } catch (err) {
    console.warn("[API] Falha ao consultar /db_meta do Firebase:", err);
  }
  return null;
}

/**
 * Tenta carregar o catálogo/banco do Firebase RTDB apenas quando necessário.
 * Se `forcarDownload` for falso e `metaLocalTimestamp > 0`, verifica `/db_meta.json` antes
 * e evita baixar `/db_json.json` caso a nuvem não tenha versão mais nova.
 * @param {{ forcarDownload?: boolean, metaLocalTimestamp?: number }} [opcoes]
 * @returns {Promise<object | null>}
 */
export async function carregarDbFirebase({ forcarDownload = false, metaLocalTimestamp = 0 } = {}) {
  if (!FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) return null;

  try {
    if (!forcarDownload && Number(metaLocalTimestamp) > 0) {
      const meta = await carregarDbMetaFirebase();
      if (meta && Number(meta.atualizado_em || 0) <= Number(metaLocalTimestamp)) {
        return null;
      }
    }

    const authParam = getFirebaseParamAuth();
    const url = `${FIREBASE_RTDB_URL.replace(/\/+$/, "")}/db_json.json${authParam}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const json = await resp.json();
      if (json && (json.filhos || json.semestres)) {
        return json;
      }
    }
  } catch (err) {
    console.warn("[API] Falha ao sincronizar DB do Firebase:", err);
  }
  return null;
}

/**
 * Baixa sob demanda o conteúdo textual (Markdown e artefatos JSON/MD) de uma única aula
 * em `/db_conteudo/{aulaId}.json` (~15 KB), com deduplicação, cache em memória e
 * cache persistente no navegador (Cache API) versionado por `atualizado_em`.
 * @param {string} aulaId
 * @returns {Promise<object | null>}
 */
export async function carregarConteudoAulaFirebase(aulaId) {
  const chave = String(aulaId || "").trim();
  if (!chave || !FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) return null;
  if (_cacheConteudoAulaFetched.has(chave)) {
    return _cacheConteudoAulaFetched.get(chave);
  }

  const emCachePersistente = await lerConteudoDoBrowserCache(chave);
  if (emCachePersistente) {
    _cacheConteudoAulaFetched.set(chave, emCachePersistente);
    return emCachePersistente;
  }

  try {
    const authParam = getFirebaseParamAuth();
    const url = `${FIREBASE_RTDB_URL.replace(/\/+$/, "")}/db_conteudo/${encodeURIComponent(chave)}.json${authParam}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const json = await resp.json();
    const resultado = json && typeof json === "object" ? json : null;
    _cacheConteudoAulaFetched.set(chave, resultado);
    if (resultado) {
      gravarConteudoNoBrowserCache(chave, resultado);
    }
    return resultado;
  } catch (err) {
    console.warn(`[API] Falha ao carregar conteúdo sob demanda da aula '${chave}':`, err);
    return null;
  }
}

function aulaPrecisaHidratacaoConteudo(aula) {
  if (!aula || typeof aula !== "object") return false;
  const arquivos = Array.isArray(aula.arquivos) ? aula.arquivos : [];
  const faltaMd = arquivos.some(arq => {
    if (!arq || classificarArquivoArtefato(arq).ehNovoArtefato) return false;
    const ext = String(arq.tipo || "").toLowerCase();
    const ehMd = ext === "md" || ext === "markdown" || /\.(md|markdown)$/i.test(String(arq.nome || ""));
    return ehMd && !arq.conteudoTexto;
  });
  if (faltaMd) return true;

  const arts = aula.artifacts && typeof aula.artifacts === "object" ? aula.artifacts : {};
  for (const role of ["mindmap", "flashcards", "quiz", "relatorio"]) {
    const item = arts[role];
    if (!item || typeof item !== "object") continue;
    if (role === "mindmap" && !item.conteudoJson && !item.conteudoTexto) return true;
    if (role !== "mindmap" && !item.conteudoTexto) return true;
  }
  return false;
}

/**
 * Hidrata uma aula carregada do catálogo leve buscando `/db_conteudo/{aulaId}.json`
 * somente se algum `.md` ou artefato ainda estiver sem conteúdo inline em memória.
 * @param {object} aula
 * @returns {Promise<boolean>}
 */
export async function hidratarConteudoAulaSobDemanda(aula) {
  if (!aulaPrecisaHidratacaoConteudo(aula)) return false;

  const chave = String(aula.conteudoId || aula.id || "").trim();
  if (!chave) return false;

  if (_promisesHydratacaoAula.has(chave)) {
    return _promisesHydratacaoAula.get(chave);
  }

  const promessa = (async () => {
    try {
      const payload = await carregarConteudoAulaFirebase(chave);
      if (!payload || typeof payload !== "object") return false;

      let atualizou = false;
      const mdsRaw = payload.mds && typeof payload.mds === "object" ? payload.mds : {};
      const mdsMap = {};
      for (const [k, v] of Object.entries(mdsRaw)) {
        // Desanitiza chaves do Firebase (_p_ -> ., _ds_ -> $, _h_ -> #, _bo_ -> [, _bc_ -> ], _sl_ -> /)
        const desan = String(k)
          .replace(/_p_/g, ".")
          .replace(/_ds_/g, "$")
          .replace(/_h_/g, "#")
          .replace(/_bo_/g, "[")
          .replace(/_bc_/g, "]")
          .replace(/_sl_/g, "/");
        mdsMap[k] = v;
        mdsMap[desan] = v;
      }
      const mdsEntries = Object.entries(mdsMap);
      if (mdsEntries.length > 0 && Array.isArray(aula.arquivos)) {
        const mdsLower = new Map(mdsEntries.map(([k, v]) => [String(k).toLowerCase(), v]));
        const mdArqs = aula.arquivos.filter(a => {
          if (!a || classificarArquivoArtefato(a).ehNovoArtefato) return false;
          const ext = String(a.tipo || "").toLowerCase();
          return ext === "md" || ext === "markdown" || /\.(md|markdown)$/i.test(String(a.nome || ""));
        });
        for (const arq of mdArqs) {
          if (arq.conteudoTexto) continue;
          const nomeLow = String(arq.nome || "").toLowerCase();
          const textoMatch =
            mdsMap[arq.nome] ??
            mdsLower.get(nomeLow) ??
            (mdArqs.length === 1 && mdsEntries.length === 1 ? mdsEntries[0][1] : "");
          if (textoMatch) {
            arq.conteudoTexto = textoMatch;
            atualizou = true;
          }
        }
      }

      const artsRemotos = payload.artifacts && typeof payload.artifacts === "object" ? payload.artifacts : {};
      if (Object.keys(artsRemotos).length > 0) {
        if (!aula.artifacts || typeof aula.artifacts !== "object") {
          aula.artifacts = {};
        }
        for (const role of ["mindmap", "flashcards", "quiz", "relatorio"]) {
          const rem = artsRemotos[role];
          if (!rem || typeof rem !== "object") continue;
          const atual = aula.artifacts[role];
          const base = atual && typeof atual === "object"
            ? atual
            : { nome: rem.nome || "", tipo: role === "mindmap" ? "json" : "md", artifactRole: role };
          if (rem.conteudoJson !== undefined && rem.conteudoJson !== null && !base.conteudoJson) {
            base.conteudoJson = rem.conteudoJson;
            atualizou = true;
          }
          if (rem.conteudoTexto && !base.conteudoTexto) {
            base.conteudoTexto = rem.conteudoTexto;
            atualizou = true;
          }
          aula.artifacts[role] = base;
        }
      }

      return atualizou;
    } finally {
      _promisesHydratacaoAula.delete(chave);
    }
  })();

  _promisesHydratacaoAula.set(chave, promessa);
  return promessa;
}

/**
 * Envia uma mensagem genérica para a fila de sincronização do Firebase.
 * Exige que o usuário seja Administrador para evitar gravações não autorizadas.
 * @param {object} payload
 * @returns {Promise<{ ok: boolean, data?: any, erro?: string }>}
 */
export async function enviarParaFilaSync(payload) {
  if (!FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) {
    return { ok: true, offline: true };
  }

  if (!isAdminAutenticado()) {
    return {
      ok: false,
      erro: "Acesso negado: Somente administradores autenticados podem gravar alterações na fila do Firebase."
    };
  }

  try {
    const authParam = getFirebaseParamAuth();
    const urlFila = `${FIREBASE_RTDB_URL.replace(/\/+$/, "")}/fila_md.json${authParam}`;
    const resp = await fetch(urlFila, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        throw new Error("Permissão negada no Firebase (HTTP 401). Cole o conteúdo de database.rules.json nas regras do seu Firebase Realtime Database para autorizar a gravação da fila.");
      }
      throw new Error(`HTTP ${resp.status} - Erro de resposta do Firebase`);
    }

    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/**
 * Envia edição de texto Markdown para a fila.
 */
export async function enviarFilaEdicaoMd({ localPath, arquivoId, novoTexto }) {
  return enviarParaFilaSync({
    tipo: "edicao_markdown",
    timestamp: Date.now(),
    dataHora: new Date().toISOString(),
    localPath,
    arquivoId,
    novoTexto,
    status: "pendente"
  });
}

/**
 * Envia edição ou cadastro de atividade com nota para a fila.
 */
export async function enviarFilaEdicaoAtividade({ nomeMateria, nomeAntigo, atividade }) {
  return enviarParaFilaSync({
    tipo: "edicao_atividade",
    nome_materia: nomeMateria,
    nome_antigo: nomeAntigo,
    atividade,
    timestamp: Date.now(),
    dataHora: new Date().toISOString(),
    status: "pendente"
  });
}

/**
 * Envia atualização de metadados da matéria para a fila.
 */
export async function enviarFilaEdicaoMateria({ nomeAntigo, novoNome, novoIcone, novoProf, novoStatus, novasTags, novoCover }) {
  return enviarParaFilaSync({
    tipo: "edicao_materia",
    nome_antigo: nomeAntigo,
    novo_nome: novoNome,
    novo_icone: novoIcone,
    novo_prof: novoProf,
    novo_status: novoStatus,
    novas_tags: novasTags,
    novo_cover: novoCover,
    timestamp: Date.now(),
    dataHora: new Date().toISOString(),
    status: "pendente"
  });
}

/**
 * Envia atualização de data, presença e revisão da aula para a fila.
 */
export async function enviarFilaEdicaoAulaData({ nomeMateria, numAula, novaData, presenca, revisao, linkNotebookLLM, linkDrive }) {
  return enviarParaFilaSync({
    tipo: "edicao_aula_data",
    nome_materia: nomeMateria,
    num_aula: numAula,
    nova_data: novaData,
    presenca: Boolean(presenca),
    revisao: Boolean(revisao),
    link_notebook_llm: linkNotebookLLM || "",
    link_drive: linkDrive || "",
    timestamp: Date.now(),
    dataHora: new Date().toISOString(),
    status: "pendente"
  });
}
