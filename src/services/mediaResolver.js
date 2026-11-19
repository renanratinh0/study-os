/**
 * Study OS V2 - Media Resolver & Blob Memory Manager
 * Resolução inteligente e resiliente de fontes de mídia (Blob local, Google Drive, caminhos relativos)
 * com governança estrita de ciclo de vida e liberação de memória via URL.revokeObjectURL.
 */

import { slugify, normalizarCaminhoChave } from "../utils/domHelpers.js";
import { obterBaseMediaPath } from "./storage.js";
import {
  normalizarNomeArtefato,
  classificarArquivoArtefato,
  separarArtefatosDaAula
} from "../utils/artifactsClassifier.js";

export {
  normalizarNomeArtefato,
  classificarArquivoArtefato,
  separarArtefatosDaAula
};

// Mapeamentos em memória isolados
const arquivosLocaisMap = new Map();
const blobUrlsPorAula = new Map();

/**
 * Retorna o mapa de arquivos locais indexados.
 * @returns {Map<string, File>}
 */
export function getArquivosLocaisMap() {
  return arquivosLocaisMap;
}

/**
 * Indexa arquivos vinculados a partir de um FileList local (pasta do PC).
 * Mapeia múltiplos padrões de chave para resolução flexível.
 * @param {FileList | File[]} fileList
 * @returns {number} Quantidade de arquivos mapeados
 */
export function indexarPastaLocal(fileList) {
  if (!fileList || fileList.length === 0) return 0;
  arquivosLocaisMap.clear();

  let count = 0;
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const relPath = String(file.webkitRelativePath || file.name).replace(/\\/g, "/");
    const partes = relPath.split("/");
    const semRaiz = partes.length > 1 ? partes.slice(1).join("/") : relPath;

    arquivosLocaisMap.set(normalizarCaminhoChave(semRaiz), file);
    arquivosLocaisMap.set(normalizarCaminhoChave(relPath), file);
    if (partes.length >= 3) {
      arquivosLocaisMap.set(normalizarCaminhoChave(partes.slice(-3).join("/")), file);
    }
    count++;
  }

  return count;
}

/**
 * Revoga todos os Blob URLs gerados para uma aula específica para evitar Memory Leaks.
 * @param {string} aulaId
 */
export function revogarBlobsDaAula(aulaId) {
  if (!aulaId) return;
  const lista = blobUrlsPorAula.get(aulaId);
  if (lista && lista.length > 0) {
    lista.forEach(url => {
      try {
        if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(url);
        }
      } catch (_) {}
    });
    blobUrlsPorAula.delete(aulaId);
  }
}

/**
 * Revoga todos os Blob URLs armazenados em memória no app.
 */
export function revogarTodosBlobs() {
  for (const aulaId of blobUrlsPorAula.keys()) {
    revogarBlobsDaAula(aulaId);
  }
  blobUrlsPorAula.clear();
}

/**
 * Resolve todas as fontes potenciais de uma mídia (Blob, Google Drive, disco local).
 * @param {object} arq Objeto do arquivo com local, driveId, nome, tipo
 * @param {string} [aulaId] ID da aula para vinculação do ciclo de vida do Blob
 * @param {string} [baseMediaPathOverride] Prefixo de caminho customizado
 * @returns {object} URLs resolvidas e flags de validação
 */
export function resolverFontesMidia(arq, aulaId = "", baseMediaPathOverride = "") {
  const localRel = String(arq?.local || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const chaveNorm = normalizarCaminhoChave(localRel);

  let fileLocal = arquivosLocaisMap.get(chaveNorm);
  if (!fileLocal && localRel) {
    const partes = localRel.split("/");
    if (partes.length >= 3) {
      fileLocal = arquivosLocaisMap.get(normalizarCaminhoChave(partes.slice(-3).join("/")));
    }
  }

  let blobUrl = "";
  if (fileLocal && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      blobUrl = URL.createObjectURL(fileLocal);
      if (aulaId) {
        if (!blobUrlsPorAula.has(aulaId)) blobUrlsPorAula.set(aulaId, []);
        blobUrlsPorAula.get(aulaId).push(blobUrl);
      }
    } catch (_) {}
  }

  const rawDriveId = String(arq?.driveId || arq?.id || "").trim();
  const driveIdValido =
    rawDriveId.length >= 12 &&
    !rawDriveId.includes("/") &&
    !rawDriveId.includes(" ") &&
    rawDriveId !== slugify(arq?.local || arq?.nome || "")
      ? rawDriveId
      : "";

  const urlDrivePreview = driveIdValido ? `https://drive.google.com/file/d/${driveIdValido}/preview` : "";
  const urlDriveImage = driveIdValido ? `https://lh3.googleusercontent.com/d/${driveIdValido}=w2000` : "";
  const urlDriveThumb = driveIdValido ? `https://drive.google.com/thumbnail?id=${driveIdValido}&sz=w2000` : "";
  const urlDriveDownload = driveIdValido ? `https://drive.google.com/uc?export=download&id=${driveIdValido}` : "";
  const urlDriveStream = driveIdValido ? `https://docs.google.com/uc?export=open&id=${driveIdValido}` : "";
  const urlDriveDirect = driveIdValido ? `https://drive.usercontent.google.com/download?id=${driveIdValido}` : "";
  const urlDriveView = driveIdValido ? `https://drive.google.com/file/d/${driveIdValido}/view` : "";

  const partesCodificadas = localRel
    .split("/")
    .filter(Boolean)
    .map(p => encodeURIComponent(p))
    .join("/");

  const baseMedia = baseMediaPathOverride || obterBaseMediaPath();
  const prefixoConfigurado = String(baseMedia).replace(/\/+$/, "");
  const urlLocalConfigurado = partesCodificadas ? `${prefixoConfigurado}/${partesCodificadas}` : "";
  const urlLocalDireto = partesCodificadas ? `./${partesCodificadas}` : "";

  return {
    blobUrl,
    driveIdValido,
    urlDrivePreview,
    urlDriveImage,
    urlDriveThumb,
    urlDriveDownload,
    urlDriveStream,
    urlDriveDirect,
    urlDriveView,
    urlLocalConfigurado,
    urlLocalDireto,
    temFonteValida: Boolean(blobUrl || driveIdValido || urlLocalConfigurado)
  };
}

/**
 * Otimiza URLs de capa externa (ex: Unsplash) reduzindo resolução para manter FCP veloz.
 * @param {string} url
 * @returns {string}
 */
export function otimizarUrlCapa(url) {
  if (!url || url.includes("amazonaws.com") || url.includes("prod-files-secure")) {
    return "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=420&q=70";
  }
  if (url.includes("unsplash.com")) {
    return url.replace(/w=\d+/, "w=420").replace(/q=\d+/, "q=70");
  }
  return url;
}

/**
 * Busca nos arquivos locais vinculados (Pasta Local no PC) um artefato específico da aula
 * pelo seu caminho da pasta + sufixo estrito (ex: 'mapa-mental.json', 'flashcards.md').
 * @param {object} aula
 * @param {string} role
 * @returns {File | null}
 */
export function buscarArtefatoNoMapaLocal(aula, role) {
  if (!arquivosLocaisMap || arquivosLocaisMap.size === 0 || !aula) return null;
  const pastaAulaNorm = normalizarCaminhoChave(aula.local || "");

  for (const [chave, file] of arquivosLocaisMap.entries()) {
    const classif = classificarArquivoArtefato(file?.name || chave);
    if (classif.role !== role) continue;

    if (!pastaAulaNorm || chave.includes(pastaAulaNorm)) {
      return file;
    }
  }
  return null;
}

function normalizarEntradaArtefato(rawItem, urlFallback, role) {
  if (!rawItem && !urlFallback) return null;

  if (typeof rawItem === "string") {
    const trimmed = rawItem.trim();
    if (!trimmed) return null;
    if (role === "mindmap" && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try {
        return { nome: "mapa-mental.json", conteudoJson: JSON.parse(trimmed), conteudoTexto: trimmed };
      } catch (_) {}
    }
    return { nome: trimmed.split("/").pop() || trimmed, local: trimmed, url: trimmed };
  }

  if (typeof rawItem === "object") {
    return {
      ...rawItem,
      url: rawItem.url || urlFallback || ""
    };
  }

  return null;
}

/**
 * Resolve e isola os 4 novos artefatos da aula (Camadas 6 a 9) aplicando prioridade estrita
 * e degradação graciosa (sem dados mockup injetados).
 *
 * @param {object} aula
 * @returns {{
 *   mindmap: { existe: boolean, nome: string, arquivo: object | null, fileLocal: File | null, url: string, dataJson: object | null, rawText: string },
 *   flashcards: { existe: boolean, nome: string, arquivo: object | null, fileLocal: File | null, url: string, markdown: string },
 *   quiz: { existe: boolean, nome: string, arquivo: object | null, fileLocal: File | null, url: string, markdown: string },
 *   relatorio: { existe: boolean, nome: string, arquivo: object | null, fileLocal: File | null, url: string, markdown: string }
 * }}
 */
export function resolverArtefatosAula(aula) {
  const listaArquivos = Array.isArray(aula?.arquivos)
    ? aula.arquivos
    : (Array.isArray(aula?.filhos) ? aula.filhos : []);
  const separados = separarArtefatosDaAula(listaArquivos);
  const artObj = aula?.artifacts || {};

  const criarDescriptor = (role, defaultNome, urlField) => {
    const itemBruto = artObj[role] || separados.artifacts[role] || null;
    const urlDireta = String(aula?.[urlField] || "").trim();
    const arq = normalizarEntradaArtefato(itemBruto, urlDireta, role);
    const fileLocal = buscarArtefatoNoMapaLocal(aula, role);

    let urlResolvida = urlDireta;
    if (arq) {
      const fontes = resolverFontesMidia(arq, aula?.id || "");
      urlResolvida = urlResolvida || arq.url || fontes.urlLocalConfigurado || fontes.urlLocalDireto || fontes.urlDriveDownload || "";
    }

    const existe = Boolean(arq || fileLocal || urlDireta);

    if (role === "mindmap") {
      let dataJson = arq?.conteudoJson || null;
      if (!dataJson && arq && (arq.name || arq.root) && Array.isArray(arq.children || arq.root?.children)) {
        dataJson = arq;
      }
      const rawText = String(arq?.conteudoTexto || "");
      if (!dataJson && rawText.trim().startsWith("{")) {
        try {
          dataJson = JSON.parse(rawText);
        } catch (_) {}
      }

      return {
        existe,
        nome: arq?.nome || fileLocal?.name || defaultNome,
        arquivo: arq,
        fileLocal,
        url: urlResolvida,
        dataJson,
        rawText
      };
    }

    const markdown = String(arq?.conteudoTexto || arq?.conteudo || arq?.texto || "");

    return {
      existe,
      nome: arq?.nome || fileLocal?.name || defaultNome,
      arquivo: arq,
      fileLocal,
      url: urlResolvida,
      markdown
    };
  };

  return {
    mindmap: criarDescriptor("mindmap", "mapa-mental.json", "mindmapUrl"),
    flashcards: criarDescriptor("flashcards", "flashcards.md", "flashcardsUrl"),
    quiz: criarDescriptor("quiz", "quiz.md", "quizUrl"),
    relatorio: criarDescriptor("relatorio", "relatorio.md", "relatorioUrl")
  };
}

/**
 * Carrega de forma assíncrona o conteúdo de um artefato (de conteúdo embutido, File local no PC ou fetch HTTP relativo).
 * @param {object} descriptor
 * @param {string} [aulaId=""]
 * @param {'json' | 'text'} [tipo="text"]
 * @returns {Promise<any>}
 */
export async function carregarConteudoArtefato(descriptor, aulaId = "", tipo = "text") {
  if (!descriptor || !descriptor.existe) return null;

  if (tipo === "json" && descriptor.dataJson) {
    return descriptor.dataJson;
  }
  if (tipo === "text" && descriptor.markdown) {
    return descriptor.markdown;
  }

  if (descriptor.fileLocal && typeof descriptor.fileLocal.text === "function") {
    try {
      const txt = await descriptor.fileLocal.text();
      if (tipo === "json") return JSON.parse(txt);
      return txt;
    } catch (_) {}
  }

  const candidatos = [];
  if (descriptor.arquivo) {
    const f = resolverFontesMidia(descriptor.arquivo, aulaId);
    if (f.blobUrl) candidatos.push(f.blobUrl);
    if (f.urlLocalConfigurado) candidatos.push(f.urlLocalConfigurado);
    if (f.urlLocalDireto) candidatos.push(f.urlLocalDireto);
  }
  if (descriptor.url && !candidatos.includes(descriptor.url)) {
    candidatos.push(descriptor.url);
  }

  for (const url of candidatos) {
    if (!url || url.includes("drive.google.com/file/d/")) continue;
    try {
      if (typeof fetch !== "function") break;
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) continue;
      if (tipo === "json") {
        return await resp.json();
      }
      return await resp.text();
    } catch (_) {}
  }

  return null;
}
