/**
 * Study OS V2 - Reactive Centralized Store
 * Gerenciamento de estado global reativo com padrão Observer,
 * normalização de dados complexos do Notion/Drive e isolamento estrito de regras de negócio.
 */

import { EMPTY_DB_JSON, OPCOES_MIDIA_AULA } from "./constants.js";
import {
  slugify,
  extrairIconeENome,
  parsearTagsDisciplina,
  normalizarStatusDisciplina,
  normalizarProfessor
} from "../utils/domHelpers.js";
import { obterEdicoesMdCache } from "../services/storage.js";

class Store {
  constructor() {
    this.listeners = new Set();
    this.state = {
      db: null,
      databaseViewMode: "gallery",
      filtroSemestreAtivo: "todos",
      filtroStatusAtivo: "todos",
      filtroTagAtiva: "todas",
      filtroTextoInline: "",
      semestresExpandidos: new Set(),
      aulasAbertas: new Set(),
      midiasAtivasAula: new Set(OPCOES_MIDIA_AULA.map(o => o.id)),
      cacheMarkdownTexto: { ...obterEdicoesMdCache() },
      ultimoRelatorioSync: null,
      disciplinaModalAtiva: null,
      indexAtividadeModalAtiva: -1,
      disciplinaModalEditar: null,
      disciplinaModalDataAula: null,
      aulaModalDataAula: null
    };
  }

  /**
   * Retorna o snapshot atual do estado.
   * @returns {typeof this.state}
   */
  getState() {
    return this.state;
  }

  /**
   * Inscreve um ouvinte para alterações no estado.
   * @param {() => void} listener
   * @returns {() => void} Função de desinscrição (unsubscribe)
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Atualiza propriedades do estado e notifica os assinantes.
   * @param {Partial<typeof this.state>} updates
   */
  setState(updates) {
    this.state = { ...this.state, ...updates };
    this.notify();
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error("[Store] Erro no listener:", err);
      }
    }
  }

  /**
   * Reseta todos os filtros da visão do banco de dados.
   */
  resetFilters() {
    this.setState({
      filtroSemestreAtivo: "todos",
      filtroStatusAtivo: "todos",
      filtroTagAtiva: "todas",
      filtroTextoInline: ""
    });
  }

  /**
   * Atualiza o cache de edição de um arquivo Markdown na memória.
   * @param {string} cacheKey
   * @param {string} novoTexto
   */
  atualizarCacheMarkdown(cacheKey, novoTexto) {
    const novoCache = { ...this.state.cacheMarkdownTexto, [cacheKey]: novoTexto };
    this.setState({ cacheMarkdownTexto: novoCache });
  }

  /**
   * Alterna a expansão de um semestre na árvore lateral.
   * @param {string} semId
   */
  toggleSemestreExpandido(semId) {
    const novos = new Set(this.state.semestresExpandidos);
    if (novos.has(semId)) {
      novos.delete(semId);
    } else {
      novos.add(semId);
    }
    this.setState({ semestresExpandidos: novos });
  }

  /**
   * Alterna todas as pastas de semestre como abertas ou fechadas.
   */
  toggleTodosSemestres() {
    const todosIds = (this.state.db?.semestres || []).map(s => s.id);
    const novos = this.state.semestresExpandidos.size === todosIds.length
      ? new Set()
      : new Set(todosIds);
    this.setState({ semestresExpandidos: novos });
  }
}

export const store = new Store();

// ==============================================================================
// 🧠 FUNÇÕES PURAS DE NORMALIZAÇÃO DE DADOS & REGRAS DE NEGÓCIO
// ==============================================================================

/**
 * Converte um nó de arquivo bruto em objeto consistente.
 */
export function converterArquivoNode(arqNode) {
  const nome = arqNode.nome || "Arquivo";
  const mime = String(arqNode.mimeType || "").toLowerCase();
  let ext = nome.includes(".") ? nome.split(".").pop().toLowerCase() : (arqNode.tipo || "arq").toLowerCase();

  if (ext === "markdown" || mime.includes("markdown")) ext = "md";
  else if (ext === "arquivo" && mime.includes("pdf")) ext = "pdf";
  else if (ext === "arquivo" && mime.includes("video")) ext = "mp4";
  else if (ext === "arquivo" && mime.includes("audio")) ext = "m4a";
  else if (ext === "arquivo" && (mime.includes("jpeg") || mime.includes("jpg"))) ext = "jpg";
  else if (ext === "arquivo" && mime.includes("image")) ext = "png";

  const driveId = String(arqNode.id || arqNode.driveId || "").trim();
  const textoEmbutido = arqNode.conteudoTexto || arqNode.conteudo || arqNode.texto || arqNode.markdown || null;
  const temOCR = arqNode.temOCR !== undefined ? Boolean(arqNode.temOCR) : true;
  const statusOCR = arqNode.statusOCR || (temOCR ? "com_ocr" : "sem_ocr");

  return {
    id: driveId || slugify(arqNode.local || nome),
    driveId,
    nome,
    tipo: ext,
    mimeType: arqNode.mimeType || "",
    local: arqNode.local || "",
    conteudoTexto: textoEmbutido,
    temOCR,
    statusOCR,
    caracteresOCR: arqNode.caracteresOCR ?? null
  };
}

/**
 * Coleta recursivamente todos os arquivos sob pastas ou nós filhos.
 */
export function coletarArquivosRecursivo(listaNodes = []) {
  const resultado = [];
  listaNodes.forEach(item => {
    if (!item) return;
    const ehPasta = item.tipo === "pasta" || Array.isArray(item.filhos) || Array.isArray(item.arquivos);
    if (ehPasta) {
      resultado.push(...coletarArquivosRecursivo(item.filhos || item.arquivos || []));
    } else {
      resultado.push(converterArquivoNode(item));
    }
  });
  return resultado;
}

/**
 * Normaliza um nó de matéria em modelo consistente.
 */
export function converterDisciplinaNode(discNode, semestreNome) {
  const { icone, nomeLimpo } = extrairIconeENome(discNode.nome);
  const statusNorm = normalizarStatusDisciplina(discNode.Status ?? discNode.status);
  const tagsList = parsearTagsDisciplina(discNode.TAGS ?? discNode.tags);
  const filhos = Array.isArray(discNode.filhos) ? discNode.filhos : (Array.isArray(discNode.aulas) ? discNode.aulas : []);

  const aulas = [];
  const arquivosSoltos = [];

  filhos.forEach(item => {
    if (!item) return;
    const ehPasta = item.tipo === "pasta" || Array.isArray(item.filhos) || Array.isArray(item.arquivos);
    if (ehPasta) {
      const arqsCru = item.filhos || item.arquivos || [];
      const arquivosConvertidos = coletarArquivosRecursivo(arqsCru);
      const linkNotebook =
        item.linkNotebookLLM ??
        item.linkNotebookLM ??
        item.notebookLLM ??
        item.notebookLM ??
        "";
      const linkDrive = item.linkDrive ?? item.linkGoogleDrive ?? "";
      const driveIdFinal = extrairDriveIdDeLink(item.id || linkDrive || "");

      aulas.push({
        id: slugify(`${semestreNome}-${nomeLimpo}-${item.nome}`),
        driveId: driveIdFinal,
        linkDrive: String(linkDrive || "").trim(),
        nome: item.nome || "Aula",
        local: item.local || "",
        linkNotebookLLM: String(linkNotebook || "").trim(),
        data_aula: item.data_aula || "",
        presenca: item.presenca ?? null,
        revisao: Boolean(item.revisao || item.revisao_aula),
        arquivos: arquivosConvertidos
      });
    } else {
      arquivosSoltos.push(converterArquivoNode(item));
    }
  });

  if (arquivosSoltos.length > 0) {
    aulas.unshift({
      id: slugify(`${semestreNome}-${nomeLimpo}-materiais-gerais`),
      driveId: discNode.id || "",
      nome: "Materiais & Arquivos da Disciplina",
      local: discNode.local || "",
      linkNotebookLLM: String(discNode.linkNotebookLLM || "").trim(),
      data_aula: "",
      presenca: null,
      revisao: false,
      arquivos: arquivosSoltos
    });
  }

  aulas.sort((a, b) => {
    const isConcA = a.nome.toLowerCase().includes("conclus");
    const isConcB = b.nome.toLowerCase().includes("conclus");
    if (isConcA && !isConcB) return 1;
    if (!isConcA && isConcB) return -1;
    const numA = parseInt((a.nome.match(/\d+/) || [999])[0], 10);
    const numB = parseInt((b.nome.match(/\d+/) || [999])[0], 10);
    if (numA !== numB) return numA - numB;
    return a.nome.localeCompare(b.nome);
  });

  return {
    id: slugify(`${semestreNome}-${nomeLimpo}`),
    driveId: discNode.id || "",
    nome: nomeLimpo,
    nomeOriginal: discNode.nome,
    icone: discNode.icone || icone,
    prof: normalizarProfessor(discNode.prof),
    status: statusNorm,
    cover: discNode.cover || "",
    TAGS: tagsList,
    caminhoLocal: discNode.local || `${semestreNome}/${discNode.nome}`,
    atividades: Array.isArray(discNode.atividades) ? discNode.atividades : [],
    aulas
  };
}

/**
 * Normaliza o banco de dados recebido de qualquer fonte (arquivo original, Google Drive ou Firebase).
 */
export function normalizarDb(raw) {
  if (!raw) return structuredClone(EMPTY_DB_JSON);

  if (Array.isArray(raw.semestres)) {
    raw.semestres.forEach(sem => {
      (sem.disciplinas || []).forEach(disc => {
        if (!disc.atividades) disc.atividades = [];
        disc.TAGS = parsearTagsDisciplina(disc.TAGS ?? disc.tags);
        (disc.aulas || []).forEach(a => {
          if (a.data_aula === undefined) a.data_aula = "";
          if (a.presenca === undefined) a.presenca = null;
          if (a.revisao === undefined) a.revisao = false;
          if (a.linkDrive === undefined) a.linkDrive = a.linkGoogleDrive || "";
          if (!a.driveId && a.linkDrive) {
            a.driveId = extrairDriveIdDeLink(a.linkDrive);
          }
        });
      });
    });
    return raw;
  }

  const raizFilhos = Array.isArray(raw.filhos) ? raw.filhos : (Array.isArray(raw) ? raw : null);
  if (raizFilhos) {
    const semestres = [];
    raizFilhos.forEach(pastaSemestre => {
      if (!pastaSemestre || (pastaSemestre.tipo && pastaSemestre.tipo !== "pasta" && !Array.isArray(pastaSemestre.filhos))) return;
      const filhosSemestre = Array.isArray(pastaSemestre.filhos) ? pastaSemestre.filhos : [];
      const disciplinasConvertidas = filhosSemestre
        .filter(f => f && (f.tipo === "pasta" || Array.isArray(f.filhos)))
        .map(discNode => converterDisciplinaNode(discNode, pastaSemestre.nome));

      semestres.push({
        id: slugify(pastaSemestre.nome),
        driveId: pastaSemestre.id || "",
        nome: pastaSemestre.nome,
        disciplinas: disciplinasConvertidas
      });
    });

    return {
      usuario: raw.usuario || "Renan",
      curso: raw.curso || "Ciência da Computação",
      diretorioRaiz: raw.local || "G:\\Meu Drive\\CienciaComputacao",
      semestres
    };
  }

  return structuredClone(EMPTY_DB_JSON);
}

/**
 * Computa estatísticas agregadas do banco de dados completo.
 */
export function calcularEstatisticasDb(db) {
  const stats = {
    semestres: (db?.semestres || []).length,
    disciplinas: 0,
    aulas: 0,
    aulasComNotebook: 0,
    arquivosTotal: 0,
    arquivosComDriveId: 0,
    pdfsComOcr: 0,
    pdfsSemOcr: 0,
    porTipo: { md: 0, pdf: 0, mp4: 0, audio: 0, img: 0, outros: 0 },
    porStatus: { aprovado: 0, andamento: 0, dp: 0, outros: 0 }
  };

  if (!db || !Array.isArray(db.semestres)) return stats;

  db.semestres.forEach(sem => {
    (sem.disciplinas || []).forEach(disc => {
      stats.disciplinas++;
      const st = String(disc.status).toLowerCase();
      if (st.includes("aprovado")) stats.porStatus.aprovado++;
      else if (st.includes("andamento")) stats.porStatus.andamento++;
      else if (st === "dp") stats.porStatus.dp++;
      else stats.porStatus.outros++;

      (disc.aulas || []).forEach(aula => {
        stats.aulas++;
        if (aula.linkNotebookLLM) stats.aulasComNotebook++;
        (aula.arquivos || []).forEach(arq => {
          stats.arquivosTotal++;
          if (arq.driveId && arq.driveId.length >= 12) stats.arquivosComDriveId++;
          const t = String(arq.tipo).toLowerCase();
          if (t === "md" || t === "txt") stats.porTipo.md++;
          else if (t === "pdf") {
            stats.porTipo.pdf++;
            if (arq.temOCR === false || arq.statusOCR === "sem_ocr") stats.pdfsSemOcr++;
            else stats.pdfsComOcr++;
          }
          else if (t === "mp4" || t === "mov" || t === "webm") stats.porTipo.mp4++;
          else if (t === "m4a" || t === "mp3" || t === "aac" || t === "wav") stats.porTipo.audio++;
          else if (["png", "jpg", "jpeg", "webp", "gif"].includes(t)) stats.porTipo.img++;
          else stats.porTipo.outros++;
        });
      });
    });
  });

  return stats;
}

/**
 * Retorna uma lista plana contendo todas as disciplinas registradas.
 */
export function obterTodasDisciplinas(db) {
  const base = db || store.getState().db;
  const lista = [];
  if (!base || !Array.isArray(base.semestres)) return lista;
  base.semestres.forEach(sem => {
    (sem.disciplinas || []).forEach(disc => {
      lista.push({ ...disc, semestreId: sem.id, semestreNome: sem.nome });
    });
  });
  return lista;
}

/**
 * Busca uma disciplina pelo seu ID ou slug do nome.
 */
export function buscarDisciplinaPorId(slugOuId, db) {
  const todas = obterTodasDisciplinas(db);
  return todas.find(d => d.id === slugOuId || slugify(d.nome) === slugOuId) || null;
}

/**
 * Busca uma referência para a disciplina e seu semestre pai no banco.
 */
export function buscarRefDisciplina(slugOuId, db) {
  const base = db || store.getState().db;
  if (!base || !Array.isArray(base.semestres)) return null;
  for (const sem of base.semestres) {
    for (const disc of (sem.disciplinas || [])) {
      if (disc.id === slugOuId || slugify(disc.nome) === slugOuId) {
        return { disc, sem };
      }
    }
  }
  return null;
}

/**
 * Avalia o status cronológico e acadêmico da aula (presença, falta, revisão, data futura).
 */
export function calcularStatusAula(aula) {
  const temData = Boolean(aula && aula.data_aula);
  const presenca = Boolean(aula && aula.presenca);
  const revisao = Boolean(aula && (aula.revisao || aula.revisao_aula));

  let falta = false;
  let dataFutura = false;

  if (temData) {
    try {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const partes = String(aula.data_aula).split("-");
      if (partes.length === 3) {
        const dtAula = new Date(parseInt(partes[0], 10), parseInt(partes[1], 10) - 1, parseInt(partes[2], 10));
        if (!isNaN(dtAula.getTime())) {
          if (dtAula < hoje && !presenca) {
            falta = true;
          } else if (dtAula > hoje) {
            dataFutura = true;
          }
        }
      }
    } catch (_) {}
  }

  return {
    temData,
    presenca,
    revisao,
    falta,
    dataFutura
  };
}

/**
 * Normaliza URLs do Google NotebookLM para comparação precisa (ignora trailing slash e query params authuser/usp).
 * @param {string} url
 * @returns {string}
 */
export function normalizarLinkNotebook(url) {
  if (!url) return "";
  let str = String(url).trim();
  if (!str.startsWith("http://") && !str.startsWith("https://")) {
    str = "https://" + str;
  }
  try {
    const parsed = new URL(str);
    const pathLimpo = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathLimpo}`;
  } catch (_) {
    return str.replace(/\/+$/, "").replace(/[?#].*$/, "");
  }
}

/**
 * Extrai o ID de arquivo ou pasta do Google Drive a partir de uma URL ou ID cru.
 * @param {string} linkOuId
 * @returns {string}
 */
export function extrairDriveIdDeLink(linkOuId) {
  if (!linkOuId) return "";
  const str = String(linkOuId).trim();
  // Se for ID alfanumérico direto sem barras ou pontos (mínimo 10 chars)
  if (/^[a-zA-Z0-9_-]{10,}$/.test(str) && !str.includes("/") && !str.includes(".")) {
    return str;
  }

  // Formato: /folders/ID
  const matchFolder = str.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (matchFolder) return matchFolder[1];

  // Formato: /d/ID
  const matchFile = str.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (matchFile) return matchFile[1];

  // Formato: ?id=ID
  const matchParam = str.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (matchParam) return matchParam[1];

  return str;
}

/**
 * Verifica se um link do NotebookLM já está sendo utilizado em outra aula.
 * @param {string} linkNotebook
 * @param {string} [disciplinaIdAtual]
 * @param {string} [aulaIdAtual]
 * @param {object} [dbInstance]
 * @returns {{ duplicado: boolean, totalOcorrencias: number, outrasAulas: Array<{ discNome: string, discId: string, aulaNome: string, aulaId: string }>, ocorrencias: Array<{ discNome: string, discId: string, aulaNome: string, aulaId: string }> }}
 */
export function verificarLinkNotebookDuplicado(linkNotebook, disciplinaIdAtual = null, aulaIdAtual = null, dbInstance = null) {
  const linkNorm = normalizarLinkNotebook(linkNotebook);
  if (!linkNorm) return { duplicado: false, totalOcorrencias: 0, outrasAulas: [], ocorrencias: [] };

  const dbAlvo = dbInstance || store.getState().db;
  const todas = obterTodasDisciplinas(dbAlvo);
  const ocorrencias = [];

  todas.forEach(disc => {
    (disc.aulas || []).forEach(aula => {
      // Ignora a própria aula sendo editada
      if (disciplinaIdAtual && aulaIdAtual && disc.id === disciplinaIdAtual && aula.id === aulaIdAtual) {
        return;
      }
      const outroNorm = normalizarLinkNotebook(aula.linkNotebookLLM);
      if (outroNorm && outroNorm === linkNorm) {
        ocorrencias.push({
          discNome: disc.nome,
          discId: disc.id,
          aulaNome: aula.nome,
          aulaId: aula.id
        });
      }
    });
  });

  return {
    duplicado: ocorrencias.length > 0,
    totalOcorrencias: ocorrencias.length + 1,
    outrasAulas: ocorrencias,
    ocorrencias
  };
}

/**
 * Audita todos os links do NotebookLM no banco de dados e retorna mapa de duplicidades.
 * @param {object} [dbInstance]
 * @returns {{ totalComLink: number, totalLinksUnicos: number, duplicatas: Array<{ link: string, total: number, aulas: Array<{ discNome: string, discId: string, aulaNome: string, aulaId: string }> }>, mapa: Map<string, Array<{ discNome: string, discId: string, aulaNome: string, aulaId: string }>> }}
 */
export function auditarLinksNotebookLLM(dbInstance = null) {
  const dbAlvo = dbInstance || store.getState().db;
  const todas = obterTodasDisciplinas(dbAlvo);
  const mapa = new Map();
  let totalComLink = 0;

  todas.forEach(disc => {
    (disc.aulas || []).forEach(aula => {
      const norm = normalizarLinkNotebook(aula.linkNotebookLLM);
      if (norm) {
        totalComLink++;
        if (!mapa.has(norm)) mapa.set(norm, []);
        mapa.get(norm).push({
          discNome: disc.nome,
          discId: disc.id,
          aulaNome: aula.nome,
          aulaId: aula.id,
          linkOriginal: aula.linkNotebookLLM
        });
      }
    });
  });

  const duplicatas = [];
  for (const [link, lista] of mapa.entries()) {
    if (lista.length > 1) {
      duplicatas.push({
        link,
        total: lista.length,
        aulas: lista
      });
    }
  }

  return {
    totalComLink,
    totalLinksUnicos: mapa.size,
    duplicatas,
    mapa
  };
}
