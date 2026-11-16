/**
 * Study OS V2 - API & Sync Service
 * Gerencia a comunicação assíncrona com o Firebase Realtime Database
 * e a fila de sincronização em nuvem do Notion.
 */

import { FIREBASE_RTDB_URL } from "../core/constants.js";
import { getFirebaseParamAuth, isAdminAutenticado } from "./auth.js";

/**
 * Tenta carregar o banco de dados local a partir de caminhos conhecidos.
 * @returns {Promise<object | null>}
 */
export async function carregarDbLocal() {
  const candidatos = ["./db.json", "db.json", "./data/db.json"];
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
 * Tenta carregar a versão mais recente do banco de dados direto do Firebase RTDB.
 * @returns {Promise<object | null>}
 */
export async function carregarDbFirebase() {
  if (!FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) return null;

  try {
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
