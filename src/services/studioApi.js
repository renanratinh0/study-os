/**
 * Study OS V2 — Studio Worker Client & Fire-and-Forget Queue Service
 *
 * REGRAS DE OURO:
 * 1. NÃO consulta o NotebookLM para listar artefatos existentes: decide entre
 *    "➕ Gerar [Tipo]" e "🔄 Regerar [Tipo]" (ou "⚡ Gerar Todos da Aula")
 *    exclusivamente com base nos dados já carregados do `db.json` / Firebase.
 * 2. Padrão "Clique Frenético" (Fire-and-Forget): o clique atualiza o botão
 *    para "⏳ Na Fila" e o contador do topo ("Fila: X | Para Revisar: Y | Cota: OK/Pausada")
 *    de forma síncrona (0ms de bloqueio), despachando para `studio_worker.py` (porta 8090)
 *    em background.
 * 3. Regra de Revisão Inteligente:
 *    - Artefatos visuais/multimídia (`infografico`, `slides`, `video`, `audio`) vão para
 *      `staging/` com status `revisao` (comparação Lado a Lado Diff A/B).
 *    - Artefatos não-visuais (`flashcards`, `quiz`, `mindmap`, `relatorio`) NÃO precisam
 *      de aprovação manual e vão direto para a pasta da aula e `db.json`.
 */

import { store } from "../core/store.js";
import { FIREBASE_RTDB_URL } from "../core/constants.js";
import { resolverFontesMidia, resolverArtefatosAula } from "./mediaResolver.js";
import { classificarArquivoArtefato } from "../utils/artifactsClassifier.js";
import { escapeHtml, mostrarToast, obterTituloAula } from "../utils/domHelpers.js";
import { salvarDbCache } from "./storage.js";
import { getFirebaseParamAuth, isAdminAutenticado } from "./auth.js";

export const STUDIO_WORKER_DEFAULT_URL = "http://127.0.0.1:8090";
export const STUDIO_ADMIN_GATE = "studyos_admin_v1";
const STORAGE_STUDIO_QUEUE_KEY = "studyos_studio_queue_v1";
const STORAGE_STUDIO_URL_KEY = "studyos_studio_worker_url_v1";

/**
 * Prompts Mestres oficiais espelhados de `prompts.json` com placeholders
 * inteligentes adaptados automaticamente para cada aula e matéria.
 */
export const PROMPTS_MESTRES_PADRAO = {
  audio: `**Task: High-Fidelity Audio Script Generation (Cognitive Mastery Edition)** **Scope of Analysis:** [FOR FOCUS, INSERT LESSON NUMBER ( )] ***Lesson Focus (Granular):** Isolate the source. Deconstruct the specific technical architecture of the lesson. * **General Synthesis (Holistic):** Connect disparate concepts into a unified "Grand Unified Theory" of the subject. **Persona: The "Distinguished Technical Architect"** You are a world-class Engineer and Cognitive Scientist (like a mix of *Lex Fridman* and *Robert C. Martin*). * **Intellectual Tone:** Articulate, precise, and authoritative. You don't use slang. You use elegant, high-resolution language. * **Mental Models:** You don't just describe "what" something is; you explain the **mental model** behind it. You teach the listener *how to think* about the problem. * **Respect for Intelligence:** You assume the listener is smart but lacks specific context. You do not "dumb down" the content; you "clarify" it. **Advanced Constraints & Guidelines:** 1. **ZERO FLUFF:** Every sentence must deliver value. No "filler" intro music descriptions. No "Hello guys". Start immediately with the core concept. 2. **The "Why" before the "How":** Always explain the *problem* that necessitated the technology before explaining the *solution*. 3. **Structural Analogies:** Use analogies that are structurally accurate (e.g., comparing CPU architecture to urban planning), not just loose metaphors. 4. **Language:** Brazilian Portuguese (PT-BR). Use standard English terminology for technical keywords (e.g., *Throughput, Latency, Deadlock*) but explain them briefly if complex. **Mission:** Synthesize dense academic material into a **premium audio-essay**. The goal is not just retention, but **insight**.`,
  videoStyle: `Prompt Visual: "High-End Tech Blueprint & Gamer HUD Edition" Cinematic 3D Tech Blueprint, Dark Mode UI & High-End Gaming Aesthetics. Atmosphere: An immersive environment that blends a "Software War Room" with a "Cyberpunk Esports Arena". Use Volumetric Lighting with deep shadows. The palette is Midnight Obsidian (#050A14) and Deep Navy, accented by glowing Neon Cyan (#00F0FF), Electric Purple, and RGB Gamer Lighting. Key Visual Elements: Background: Animated isometric grid overlays on a dark matte texture (resembling a PCB). ABSOLUTELY NO WHITE BACKGROUNDS. Game UI Metaphors: Use Health Bars (HP) to represent System Stability, XP Progress Bars (Gold/Blue) for timelines, Inventory Slots for resources. Mix high-fidelity 3D renders with subtle 8-bit Pixel Art icons.`,
  videoFocus: `**Task: Video Lesson Script & Storyboard Generation (Cinematic Tech Edition)** **Scope of Analysis:** [FOR FOCUS, INSERT LESSON NUMBER ( )] * **Lesson Focus (Granular Mode):** Isolate content strictly from that lesson, identify the core metaphor that can be visualized, and ignore unrelated materials. **Persona: The "Digital Architect & Director"** Modern Tech Lead tone (Direct, engaging, no fluff). Visual Style: Dark Blue Tech / DevOps Aesthetic (Deep Navy/Obsidian, Neon Cyan/Purple accents, pixel-art icons, isometric 3D blueprints). Output Template: Detailed Storyboard in PT-BR.`,
  relatorio: `**Task: Technical Intelligence Report Generation (Senior Architect Edition)** **Scope of Analysis:** [FOR FOCUS, INSERT LESSON NUMBER ( )] * **Lesson Focus (Granular Mode):** Isolate content strictly from that lesson. Root Cause Analysis: Identify the core technical thesis driving the lesson. **Persona: The "Senior Technical Architect/CTO"** Prioritize scalability, maintainability, and risk mitigation in professional Brazilian Portuguese (PT-BR). Output Template: RELATÓRIO DE INTELIGÊNCIA TÉCNICA: [TOPIC NAME] with 1. Executive Summary, 2. Architectural Breakdown, 3. Strategic Implications, 4. Risk Assessment, 5. Technical Glossary.`,
  flashcards: `**Task: Final Review Deck Generation (Gamer Mindset Edition)** **Scope of Analysis: [FULL REVIEW]** **Persona: The "Chill Gamer Professor" (Learning Scientist Mindset)** Create an Active Recall deck in professional Brazilian Portuguese (PT-BR), prioritizing connection, comparison, cause/effect, and scenario cards.`,
  quiz: `**Task: Comprehensive Technical Assessment Generation (Certification/Interview Mode)** **Scope of Analysis:** [ALL COVERED THEMES] **Persona: The "Senior Engineering Manager / Lead Interviewer"** Value First Principles, Critical Thinking, and Trade-off Analysis in Brazilian Portuguese (PT-BR). Progress across Bloom's Taxonomy (Screening, Scenarios, System Design & Trade-offs).`,
  infografico: `High-end 3D Digital Art with a "Dark Mode" Tech Aesthetic. Subject & Composition: Clean enterprise architecture dashboard representing [INSERT LESSON CONTENT OR TOPIC HERE] in Brazilian Portuguese (PT-BR). Background: Strictly Dark Mode (deep matte charcoal, obsidian black, dark navy gradients, subtle hexagonal grid patterns, NO white backgrounds). Visual Style: Esports/HUD overlays, sharp laser vector geometry, smooth glass surfaces, Electric Cyan, Neon Purple, and Warning Orange accents. Think "IBM meets Cyberpunk 2077."`,
  slides: `Task: Cinematic Keynote Deck Generation (Unreal Engine & Gamer Edition) Scope of Analysis: [INSERT LESSON CONTENT OR TOPIC HERE] Visual Philosophy: Embrace "Cyber-Industrial" aesthetics in Brazilian Portuguese (PT-BR). Convert abstract concepts into Game Mechanics (Health Bar, XP Progress Bar). Narrative Arc: Hero's Journey (Threat -> Weapon -> Victory). STRICT DARK MODE (#050A14, Charcoal, Matte Black, NO white backgrounds), Unreal Engine 5 / Octane Render visuals + 8-bit Pixel Art contrast + Gamer HUD overlays.`
};

/**
 * Substitui placeholders genéricos dos prompts pelo título/número da aula e matéria.
 */
export function adaptarPromptParaAula(promptBruto, { aulaNome = "", aulaTitulo = "", materiaNome = "" } = {}) {
  const raw = String(promptBruto || "");
  if (!raw) return "";

  const tituloLimpo = String(aulaTitulo || aulaNome || "Aula").trim();
  const tituloFinal = aulaNome && aulaTitulo && !aulaTitulo.toLowerCase().includes(aulaNome.toLowerCase())
    ? `${aulaNome} — ${tituloLimpo}`
    : tituloLimpo;
  const materiaFinal = String(materiaNome || "Disciplina").trim();
  const contextoCompleto = `${tituloFinal} (Matéria: ${materiaFinal})`;

  return raw
    .replace(/\[FOR FOCUS,\s*INSERT LESSON NUMBER\s*\(\s*\)\]/gi, `Foco na ${contextoCompleto}`)
    .replace(/\[INSERT LESSON CONTENT OR TOPIC HERE\]/gi, contextoCompleto)
    .replace(/\[TOPIC NAME\]/gi, tituloFinal)
    .replace(/\[Topic\]/gi, tituloFinal)
    .replace(/\[Matéria\]/gi, materiaFinal)
    .replace(/\[Subject\]/gi, `${materiaFinal} — ${tituloFinal}`)
    .replace(/\[NOME GERAL DA MATÉRIA\]/gi, `${materiaFinal} — ${tituloFinal}`)
    .replace(/\[FULL REVIEW\]/gi, contextoCompleto)
    .replace(/\[ALL COVERED THEMES\]/gi, contextoCompleto);
}

/**
 * Constrói a configuração completa de geração do artefato no NotebookLM
 * combinando as opções fixas de UI + prompt adaptado da aula.
 */
export function construirConfigGeracaoArtefato(tipoArtefato, contexto = {}) {
  const tipo = String(tipoArtefato || "").toLowerCase();

  if (tipo === "video") {
    const estilo = adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.videoStyle, contexto);
    const assunto = adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.videoFocus, contexto);
    return {
      formato: "Video explicativo",
      escolher_estilo_visual: "Visual personalizado",
      estilo_visual_personalizado: estilo,
      foco_video: "", // Sempre vazio conforme especificação
      assunto_personalizado: assunto,
      resumo_label: "Video explicativo • Visual personalizado"
    };
  }

  if (tipo === "relatorio") {
    return {
      formato: "Documento",
      modelo: "Crie do zero",
      descricao_relatorio: adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.relatorio, contexto),
      resumo_label: "Documento • Crie do zero"
    };
  }

  if (tipo === "quiz") {
    return {
      numero_questoes: "Mais",
      nivel_dificuldade: "Média",
      incluir_imagens: true,
      tipos_perguntas: [
        "Uma resposta correta",
        "Mais de uma resposta correta",
        "Preencher a lacuna",
        "Resposta curta"
      ],
      tema: adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.quiz, contexto),
      resumo_label: "Mais questões • Dificuldade Média • Imagens + Todos os tipos"
    };
  }

  if (tipo === "audio") {
    return {
      formato: "Análise detalhada",
      foco_apresentadores: adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.audio, contexto),
      resumo_label: "Análise detalhada"
    };
  }

  if (tipo === "slides") {
    return {
      formato: "Apresentação detalhada",
      duracao: "Padrão",
      descricao_slides: adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.slides, contexto),
      resumo_label: "Apresentação detalhada • Duração Padrão"
    };
  }

  if (tipo === "mindmap") {
    return {
      modo: "Padrão de fábrica",
      prompt: "",
      resumo_label: "Padrão de fábrica"
    };
  }

  if (tipo === "flashcards") {
    return {
      numero_cards: "Mais",
      nivel_dificuldade: "Média padrão",
      incluir_imagens: true,
      tema: adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.flashcards, contexto),
      resumo_label: "Mais cards • Média padrão • Com imagens"
    };
  }

  if (tipo === "infografico") {
    return {
      escolher_estilo_visual: "Seleção automática",
      orientacao: "Paisagem",
      nivel_detalhamento: "Padrão",
      descricao_infografico: adaptarPromptParaAula(PROMPTS_MESTRES_PADRAO.infografico, contexto),
      resumo_label: "Seleção automática • Paisagem • Detalhamento Padrão"
    };
  }

  return {};
}

/**
 * Catálogo oficial dos 8 tipos de artefatos gerados pelo NotebookLM Studio.
 */
export const STUDIO_ARTIFACT_TYPES = [
  {
    id: "audio",
    icone: "🎧",
    labelCurto: "Áudio",
    labelCompleto: "Resumo de Áudio (.M4A)",
    extensao: "m4a",
    nomePadrao: "Resumo em Áudio.m4a",
    requerRevisao: true
  },
  {
    id: "slides",
    icone: "🖥️",
    labelCurto: "Slides",
    labelCompleto: "Apresentação de Slides (.PDF)",
    extensao: "pdf",
    nomePadrao: "Apresentação de Slides.pdf",
    requerRevisao: true
  },
  {
    id: "video",
    icone: "🎬",
    labelCurto: "Vídeo",
    labelCompleto: "Resumo em Vídeo (.MP4)",
    extensao: "mp4",
    nomePadrao: "Resumo em Vídeo.mp4",
    requerRevisao: true
  },
  {
    id: "infografico",
    icone: "🖼️",
    labelCurto: "Infográfico",
    labelCompleto: "Infográfico (.PNG)",
    extensao: "png",
    nomePadrao: "Infográfico Arquitetural.png",
    requerRevisao: true
  },
  {
    id: "mindmap",
    icone: "🧠",
    labelCurto: "Mapa Mental",
    labelCompleto: "Mapa Mental (mapa-mental.json)",
    extensao: "json",
    nomePadrao: "mapa-mental.json",
    requerRevisao: false
  },
  {
    id: "relatorio",
    icone: "📄",
    labelCurto: "Relatório",
    labelCompleto: "Relatório Técnico (relatorio.md)",
    extensao: "md",
    nomePadrao: "relatorio.md",
    requerRevisao: false
  },
  {
    id: "flashcards",
    icone: "🃏",
    labelCurto: "Flashcards",
    labelCompleto: "Cartões Didáticos (flashcards.md)",
    extensao: "md",
    nomePadrao: "flashcards.md",
    requerRevisao: false
  },
  {
    id: "quiz",
    icone: "🎯",
    labelCurto: "Quiz",
    labelCompleto: "Teste / Quiz (quiz.md)",
    extensao: "md",
    nomePadrao: "quiz.md",
    requerRevisao: false
  }
];

export const MAPA_TIPOS_STUDIO = Object.fromEntries(
  STUDIO_ARTIFACT_TYPES.map(t => [t.id, t])
);

/**
 * Ordem oficial de geração dos artefatos dentro de cada aula.
 */
export const ORDEM_EXECUCAO_ARTEFATOS_STUDIO = [
  "mindmap",
  "flashcards",
  "quiz",
  "relatorio",
  "infografico",
  "slides",
  "audio",
  "video"
];

export const MAPA_PRIORIDADE_ARTEFATO_STUDIO = Object.fromEntries(
  ORDEM_EXECUCAO_ARTEFATOS_STUDIO.map((id, idx) => [id, idx + 1])
);

function normalizarSlugOrdem(txt) {
  return String(txt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "zzz";
}

function extrairPartesOrdemJob(job) {
  const pasta = String(job?.pasta_aula || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const partes = pasta ? pasta.split("/").map(p => p.trim()).filter(Boolean) : [];
  let sem = String(job?.semestre_nome || partes[0] || "").trim();
  const mat = String(job?.materia_nome || partes[1] || job?.materia_id || "").trim();
  const aula = String(job?.aula_nome || partes[2] || job?.aula_id || "").trim();
  if (!sem) {
    const refId = String(job?.materia_id || job?.aula_id || "");
    const mSem = refId.match(/^(\d+)[°º-]?\s*semestre/i);
    if (mSem) sem = `${mSem[1]}° semestre`;
  }
  return { sem, mat, aula };
}

function chaveSemestreJs(semTxt) {
  const m = String(semTxt || "").match(/(\d+)/);
  return {
    grupo: m ? 0 : 1,
    num: m ? parseInt(m[1], 10) : 9999,
    norm: normalizarSlugOrdem(semTxt)
  };
}

function chaveAulaJs(aulaTxt) {
  const low = String(aulaTxt || "").toLowerCase();
  const isConc = low.includes("conclus") ? 1 : 0;
  const m = String(aulaTxt || "").match(/(\d+)/);
  return {
    isConc,
    num: m && !isConc ? parseInt(m[1], 10) : 9999,
    norm: normalizarSlugOrdem(aulaTxt)
  };
}

/**
 * Comparador hierárquico espelhado 1:1 com `chave_ordenacao_hierarquica_job` do `studio_worker.py`:
 * 1º Semestre (1° -> 2° -> ... -> 8° -> Cursos/outros)
 * 2º Matéria inteira dentro do semestre
 * 3º Aula (Aula 01 -> Aula 02 -> ... -> Aula Conclusão)
 * 4º Artefato na aula (mindmap -> flashcards -> quiz -> relatorio -> infografico -> slides -> audio -> video)
 * 5º Timestamp de entrada (desempate)
 */
export function compararJobsOrdemHierarquica(a, b) {
  const pa = extrairPartesOrdemJob(a);
  const pb = extrairPartesOrdemJob(b);

  const sa = chaveSemestreJs(pa.sem);
  const sb = chaveSemestreJs(pb.sem);
  if (sa.grupo !== sb.grupo) return sa.grupo - sb.grupo;
  if (sa.num !== sb.num) return sa.num - sb.num;
  if (sa.norm !== sb.norm) return sa.norm.localeCompare(sb.norm);

  const ma = normalizarSlugOrdem(pa.mat);
  const mb = normalizarSlugOrdem(pb.mat);
  if (ma !== mb) return ma.localeCompare(mb);

  const aa = chaveAulaJs(pa.aula);
  const ab = chaveAulaJs(pb.aula);
  if (aa.isConc !== ab.isConc) return aa.isConc - ab.isConc;
  if (aa.num !== ab.num) return aa.num - ab.num;
  if (aa.norm !== ab.norm) return aa.norm.localeCompare(ab.norm);

  const ta = MAPA_PRIORIDADE_ARTEFATO_STUDIO[String(a?.tipo_artefato || "").toLowerCase()] || 99;
  const tb = MAPA_PRIORIDADE_ARTEFATO_STUDIO[String(b?.tipo_artefato || "").toLowerCase()] || 99;
  if (ta !== tb) return ta - tb;

  return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
}

// Estado reativo local da fila Studio (para atualização em 0ms no Clique Frenético)
const _studioState = {
  jobsMap: new Map(), // key: jobId -> job
  autoAprovadosProcessados: new Set(),
  cotaStatus: "OK",   // "OK" | "Pausada"
  workerOnline: false,
  pollingTimer: null,
  ultimoMetaFirebaseTs: null,
  filaEpoch: 0
};

/**
 * Obtém a URL base do Studio Worker (`http://127.0.0.1:8090`).
 */
export function getStudioWorkerUrl() {
  try {
    if (typeof localStorage !== "undefined") {
      return (localStorage.getItem(STORAGE_STUDIO_URL_KEY) || STUDIO_WORKER_DEFAULT_URL).replace(/\/+$/, "");
    }
  } catch (_) {}
  return STUDIO_WORKER_DEFAULT_URL;
}

function carregarFilaLocalStorage() {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_STUDIO_QUEUE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.jobs)) {
          _studioState.jobsMap.clear();
          parsed.jobs.forEach(j => {
            if (j && j.id) _studioState.jobsMap.set(j.id, j);
          });
        }
        if (parsed.cotaStatus) {
          _studioState.cotaStatus = parsed.cotaStatus;
        }
      }
    }
  } catch (_) {}
}

function persistirFilaLocalStorage() {
  try {
    if (typeof localStorage !== "undefined") {
      const payload = {
        cotaStatus: _studioState.cotaStatus,
        jobs: Array.from(_studioState.jobsMap.values())
      };
      localStorage.setItem(STORAGE_STUDIO_QUEUE_KEY, JSON.stringify(payload));
    }
  } catch (_) {}
}

// Inicializa a fila persistida localmente ao carregar o módulo
carregarFilaLocalStorage();

/**
 * Regra de Ouro Nº 1:
 * Inspeciona EXCLUSIVAMENTE os dados já carregados da aula no banco (`db.json` / Store)
 * sem qualquer chamada de rede ao NotebookLM.
 *
 * @param {object} aula Objeto da aula normalizado no Store
 * @returns {{
 *   porTipo: Record<string, {
 *     tipo: string,
 *     icone: string,
 *     labelCurto: string,
 *     existe: boolean,
 *     acao: 'gerar' | 'regerar',
 *     textoBotao: string,
 *     urlAntiga: string,
 *     caminhoLocalAntigo: string,
 *     requerRevisao: boolean,
 *     jobAtivo: object | null
 *   }>,
 *   possuiAlgumArtefato: boolean,
 *   totalExistentes: number,
 *   totalFaltantes: number
 * }}
 */
/**
 * Verifica estritamente se um arquivo da aula corresponde a um dos 8 tipos do Studio.
 * Impede confusão entre Camada 2A (.jpg Sketchnote 9:16 do Estúdio Gemini) e
 * Camada 2B (.png Infográfico Completo gerado pelo NotebookLM).
 */
export function ehArquivoCorrespondenteTipoStudio(arq, tipo) {
  if (!arq || !tipo) return false;

  const classif = classificarArquivoArtefato(arq);
  if (["mindmap", "flashcards", "quiz", "relatorio"].includes(tipo)) {
    return classif.role === tipo;
  }

  if (classif.ehNovoArtefato || classif.ehResumoPrincipalMd) {
    return false;
  }

  const nomeLower = String(arq.nome || "").trim().toLowerCase();
  const localLower = String(arq.local || "").trim().toLowerCase();
  const mimeLower = String(arq.mimeType || "").trim().toLowerCase();
  const extNome = nomeLower.includes(".")
    ? nomeLower.split(".").pop()
    : (localLower.includes(".") ? localLower.split(".").pop() : "");
  const rawTipo = String(arq.tipo || "").trim().toLowerCase();
  const extReal = (extNome || (rawTipo && rawTipo !== "arquivo" && rawTipo !== "pasta" ? rawTipo : "") || "").toLowerCase();

  if (extReal === "md" || extReal === "markdown") {
    return false;
  }

  if (tipo === "infografico") {
    // Camada 2A (.jpg/.jpeg/Sketchnote) NUNCA conta como Infográfico .PNG (Camada 2B)
    if (
      ["jpg", "jpeg"].includes(extReal) ||
      mimeLower.includes("jpeg") ||
      mimeLower.includes("jpg") ||
      nomeLower.includes("sketchnote")
    ) {
      return false;
    }
    return extReal === "png" || mimeLower === "image/png";
  }

  if (tipo === "slides") {
    const ehPdf = extReal === "pdf" || mimeLower.includes("pdf");
    const ehSemOcr = arq.temOCR === false || String(arq.statusOCR || "").toLowerCase() === "sem_ocr";
    return ehPdf && ehSemOcr;
  }

  if (tipo === "video") {
    return ["mp4", "mov", "webm"].includes(extReal) || mimeLower.startsWith("video/");
  }

  if (tipo === "audio") {
    return ["m4a", "mp3", "wav", "aac"].includes(extReal) || mimeLower.startsWith("audio/");
  }

  return false;
}

export function inspecionarArtefatosExistentesAula(aula) {
  const arquivos = Array.isArray(aula?.arquivos)
    ? aula.arquivos
    : (Array.isArray(aula?.filhos) ? aula.filhos : []);
  const novosArts = resolverArtefatosAula(aula || {});
  const aulaId = String(aula?.id || "");

  let arqAudio = null;
  let arqSlides = null;
  let arqVideo = null;
  let arqInfografico = null;

  arquivos.forEach(arq => {
    if (!arq) return;
    if (!arqInfografico && ehArquivoCorrespondenteTipoStudio(arq, "infografico")) {
      arqInfografico = arq;
    } else if (!arqSlides && ehArquivoCorrespondenteTipoStudio(arq, "slides")) {
      arqSlides = arq;
    } else if (!arqVideo && ehArquivoCorrespondenteTipoStudio(arq, "video")) {
      arqVideo = arq;
    } else if (!arqAudio && ehArquivoCorrespondenteTipoStudio(arq, "audio")) {
      arqAudio = arq;
    }
  });

  const resolverUrlPreviewAntiga = (arq, tipo) => {
    if (!arq) return "";
    const f = resolverFontesMidia(arq, aulaId);
    if (tipo === "infografico") {
      return f.blobUrl || f.urlDriveThumb || f.urlDriveImage || f.urlLocalConfigurado || f.urlLocalDireto || arq.local || "";
    }
    if (tipo === "slides") {
      return f.blobUrl || f.urlDrivePreview || f.urlLocalConfigurado || f.urlLocalDireto || arq.local || "";
    }
    if (tipo === "video") {
      return f.blobUrl || f.urlLocalConfigurado || f.urlDrivePreview || f.urlLocalDireto || arq.local || "";
    }
    if (tipo === "audio") {
      return f.blobUrl || f.urlDriveStream || f.urlDriveDownload || f.urlLocalConfigurado || f.urlLocalDireto || arq.local || "";
    }
    return arq.local || arq.url || "";
  };

  const mapaExistencia = {
    audio: {
      existe: Boolean(arqAudio),
      urlAntiga: resolverUrlPreviewAntiga(arqAudio, "audio"),
      caminhoLocalAntigo: arqAudio?.local || ""
    },
    slides: {
      existe: Boolean(arqSlides),
      urlAntiga: resolverUrlPreviewAntiga(arqSlides, "slides"),
      caminhoLocalAntigo: arqSlides?.local || ""
    },
    video: {
      existe: Boolean(arqVideo),
      urlAntiga: resolverUrlPreviewAntiga(arqVideo, "video"),
      caminhoLocalAntigo: arqVideo?.local || ""
    },
    infografico: {
      existe: Boolean(arqInfografico),
      urlAntiga: resolverUrlPreviewAntiga(arqInfografico, "infografico"),
      caminhoLocalAntigo: arqInfografico?.local || ""
    },
    mindmap: {
      existe: Boolean(novosArts.mindmap.existe),
      urlAntiga: novosArts.mindmap.url || "",
      caminhoLocalAntigo: novosArts.mindmap.arquivo?.local || novosArts.mindmap.url || ""
    },
    relatorio: {
      existe: Boolean(novosArts.relatorio.existe),
      urlAntiga: novosArts.relatorio.url || "",
      caminhoLocalAntigo: novosArts.relatorio.arquivo?.local || novosArts.relatorio.url || ""
    },
    flashcards: {
      existe: Boolean(novosArts.flashcards.existe),
      urlAntiga: novosArts.flashcards.url || "",
      caminhoLocalAntigo: novosArts.flashcards.arquivo?.local || novosArts.flashcards.url || ""
    },
    quiz: {
      existe: Boolean(novosArts.quiz.existe),
      urlAntiga: novosArts.quiz.url || "",
      caminhoLocalAntigo: novosArts.quiz.arquivo?.local || novosArts.quiz.url || ""
    }
  };

  const porTipo = {};
  let totalExistentes = 0;

  STUDIO_ARTIFACT_TYPES.forEach(meta => {
    const info = mapaExistencia[meta.id];
    if (info.existe) totalExistentes++;
    const acao = info.existe ? "regerar" : "gerar";
    const textoBotao = info.existe
      ? `🔄 Regerar ${meta.labelCurto}`
      : `➕ Gerar ${meta.labelCurto}`;

    const jobAtivo = buscarJobAtivoDaAula(aulaId, meta.id);

    porTipo[meta.id] = {
      tipo: meta.id,
      icone: meta.icone,
      labelCurto: meta.labelCurto,
      existe: info.existe,
      acao,
      textoBotao,
      urlAntiga: info.urlAntiga,
      caminhoLocalAntigo: info.caminhoLocalAntigo,
      requerRevisao: meta.requerRevisao,
      jobAtivo
    };
  });

  return {
    porTipo,
    possuiAlgumArtefato: totalExistentes > 0,
    totalExistentes,
    totalFaltantes: STUDIO_ARTIFACT_TYPES.length - totalExistentes
  };
}

/**
 * Busca se já existe um job ativo (`na_fila`, `gerando`, `aguardando_cota`, `revisao`)
 * para determinada aula e tipo de artefato.
 */
export function buscarJobAtivoDaAula(aulaId, tipoArtefato) {
  if (!aulaId || !tipoArtefato) return null;
  for (const job of _studioState.jobsMap.values()) {
    if (
      job.aula_id === aulaId &&
      job.tipo_artefato === tipoArtefato &&
      ["na_fila", "gerando", "aguardando_cota", "revisao"].includes(job.status)
    ) {
      return job;
    }
  }
  return null;
}

/**
 * Calcula os contadores globais da fila Studio:
 * `Fila: X | Para Revisar: Y | Cota: OK/Pausada`
 */
export function obterContadoresStudio() {
  let na_fila = 0;
  let gerando = 0;
  let aguardando_cota = 0;
  let revisao = 0;
  let concluido = 0;

  for (const job of _studioState.jobsMap.values()) {
    const st = job.status || "na_fila";
    if (st === "na_fila") na_fila++;
    else if (st === "gerando") gerando++;
    else if (st === "aguardando_cota") aguardando_cota++;
    else if (st === "revisao" && job.requer_revisao !== false) revisao++;
    else if (st === "concluido") concluido++;
  }

  const totalFila = na_fila + gerando + aguardando_cota;
  const cotaPausada = _studioState.cotaStatus === "Pausada" || aguardando_cota > 0;

  return {
    na_fila,
    gerando,
    aguardando_cota,
    revisao,
    concluido,
    totalFila,
    cota_status: cotaPausada ? "Pausada" : "OK"
  };
}

/**
 * Retorna todos os jobs atualmente na fila (ou apenas os que estão em `revisao`).
 */
export function listarJobsStudioLocal(apenasRevisao = false) {
  const todos = Array.from(_studioState.jobsMap.values()).sort(compararJobsOrdemHierarquica);
  if (apenasRevisao) {
    return todos.filter(j => j.status === "revisao" && j.requer_revisao !== false);
  }
  return todos;
}

/**
 * Limpa a fila em memória e no localStorage (usado em testes ou reset manual).
 */
export function limparFilaStudioLocal() {
  _studioState.filaEpoch++;
  _studioState.jobsMap.clear();
  _studioState.autoAprovadosProcessados.clear();
  _studioState.cotaStatus = "OK";
  _studioState.ultimoMetaFirebaseTs = null;
  persistirFilaLocalStorage();
  atualizarContadorStudioTopbarDOM();
}

/**
 * Atualiza instantaneamente o contador no topo da página (`index.html`) sem re-renderizar a view.
 */
export function atualizarContadorStudioTopbarDOM() {
  if (typeof document === "undefined") return;
  const c = obterContadoresStudio();

  const badgeEl = document.getElementById("studio-topbar-counter-badge");
  if (badgeEl) {
    const cotaClass = c.cota_status === "Pausada"
      ? "text-amber-300 font-bold"
      : "text-emerald-300 font-semibold";
    badgeEl.innerHTML = `Fila: <strong class="text-white">${c.totalFila}</strong> | Para Revisar: <strong class="${c.revisao > 0 ? "text-amber-300 underline" : "text-white"}">${c.revisao}</strong> | Cota: <span class="${cotaClass}">${c.cota_status}</span>`;
  }

  const modalCounterEl = document.getElementById("studio-modal-header-counters");
  if (modalCounterEl) {
    modalCounterEl.textContent = `Fila: ${c.totalFila} (Na Fila: ${c.na_fila} • Gerando: ${c.gerando} • Aguardando Cota: ${c.aguardando_cota}) | Para Revisar: ${c.revisao} | Cota: ${c.cota_status}`;
  }
}

/**
 * Muda instantaneamente (< 1ms) o estado visual de um botão clicado para `⏳ Na Fila`.
 * @param {HTMLElement | null} btnEl
 * @param {string} [status="na_fila"]
 */
export function aplicarEstadoVisualBotaoStudio(btnEl, status = "na_fila") {
  if (!btnEl) return;
  btnEl.setAttribute("data-studio-status", status);
  if (status === "na_fila") {
    btnEl.innerHTML = `<span>⏳</span> <span>Na Fila</span>`;
    btnEl.className = "px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold bg-amber-500/20 text-amber-200 border border-amber-400/50 transition-all flex items-center gap-1 cursor-wait shadow-xs";
  } else if (status === "gerando") {
    btnEl.innerHTML = `<span class="animate-spin">⚙️</span> <span>Gerando...</span>`;
    btnEl.className = "px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold bg-indigo-500/25 text-indigo-200 border border-indigo-400/50 transition-all flex items-center gap-1 cursor-wait shadow-xs";
  } else if (status === "aguardando_cota") {
    btnEl.innerHTML = `<span>⏸️</span> <span>Aguardando Cota</span>`;
    btnEl.className = "px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold bg-rose-500/20 text-rose-200 border border-rose-400/50 transition-all flex items-center gap-1 cursor-help shadow-xs";
  } else if (status === "revisao") {
    btnEl.innerHTML = `<span>👁️</span> <span>Em Revisão</span>`;
    btnEl.className = "px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold bg-emerald-500/20 text-emerald-200 border border-emerald-400/50 transition-all flex items-center gap-1 cursor-pointer shadow-xs";
  }
}

/**
 * Registra 1 job otimisticamente em memória (< 0.2ms) para suportar Clique Frenético
 * de 20+ botões seguidos sem qualquer lag, já anexando `config_geracao` adaptada à aula.
 */
function registrarJobOtimistaLocal(item) {
  const tipo = String(item.tipo_artefato || "").toLowerCase();
  const meta = MAPA_TIPOS_STUDIO[tipo];
  if (!meta) return null;

  // Se já existe job ativo para mesma aula e tipo, retorna o existente
  const existente = buscarJobAtivoDaAula(item.aula_id, tipo);
  if (existente) return existente;

  const jobId = item.id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const configGeracao = item.config_geracao || construirConfigGeracaoArtefato(tipo, {
    aulaNome: item.aula_nome || item.aula_id || "",
    aulaTitulo: item.aula_titulo || item.aula_nome || "",
    materiaNome: item.materia_nome || item.materia_id || ""
  });

  const novoJob = {
    id: jobId,
    materia_id: item.materia_id || "",
    materia_nome: item.materia_nome || item.materia_id || "",
    aula_id: item.aula_id || "",
    aula_nome: item.aula_nome || item.aula_id || "",
    aula_titulo: item.aula_titulo || item.aula_nome || item.aula_id || "",
    pasta_aula: item.pasta_aula || "",
    notebook_url: item.notebook_url || "",
    tipo_artefato: tipo,
    label_artefato: meta.labelCompleto,
    acao: item.acao || (item.url_antiga ? "regerar" : "gerar"),
    url_antiga: item.url_antiga || "",
    caminho_staging: `staging/${jobId}_${tipo}.${meta.extensao}`,
    staging_drive_id: "",
    staging_drive_url: "",
    requer_revisao: meta.requerRevisao,
    config_geracao: configGeracao,
    admin_gate: STUDIO_ADMIN_GATE,
    status: _studioState.cotaStatus === "Pausada" ? "aguardando_cota" : "na_fila",
    erro_log: "",
    timestamp: Date.now()
  };

  _studioState.jobsMap.set(jobId, novoJob);
  return novoJob;
}

/**
 * Remove prompts gigantes de `config_geracao` antes de gravar o job no Firebase `/fila_studio`,
 * mantendo apenas `resumo_label` (o worker local reconstrói o prompt completo a partir da aula).
 */
export function compactarJobParaFirebase(job) {
  if (!job || typeof job !== "object") return job;
  const resumoLabel = job.config_geracao?.resumo_label || "";
  return {
    ...job,
    config_geracao: { resumo_label: resumoLabel },
    admin_gate: STUDIO_ADMIN_GATE
  };
}

let _metaUpdateAgendado = false;

function agendarAtualizacaoFilaStudioMetaBackground() {
  if (!isAdminAutenticado()) return;
  if (typeof fetch !== "function" || !FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) {
    return;
  }
  if (_metaUpdateAgendado) return;
  _metaUpdateAgendado = true;
  const epoch = _studioState.filaEpoch;
  Promise.resolve().then(() => {
    _metaUpdateAgendado = false;
    if (!isAdminAutenticado() || _studioState.filaEpoch !== epoch) return;
    const authParam = getFirebaseParamAuth();
    const url = `${FIREBASE_RTDB_URL.replace(/\/+$/, "")}/fila_studio_meta.json${authParam}`;
    const agora = Date.now();
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ atualizado_em: agora, admin_gate: STUDIO_ADMIN_GATE })
    }).catch(() => {});
  });
}

/**
 * Grava ou atualiza um job diretamente no nó `/fila_studio/{jobId}` do Firebase RTDB,
 * de forma compacta, apenas quando o Administrador estiver autenticado.
 */
function persistirJobFirebaseBackground(job) {
  if (!isAdminAutenticado()) return;
  if (typeof fetch !== "function" || !FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO") || !job?.id) {
    return;
  }
  const authParam = getFirebaseParamAuth();
  const url = `${FIREBASE_RTDB_URL.replace(/\/+$/, "")}/fila_studio/${encodeURIComponent(job.id)}.json${authParam}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(compactarJobParaFirebase(job))
  }).catch(() => {});
  agendarAtualizacaoFilaStudioMetaBackground();
}

/**
 * Envia o payload assincronamente para o Firebase (`/fila_studio`) E para o `studio_worker.py` (se online),
 * sem bloquear a UI (< 1ms). Em lotes (> 1 job), agrupa via PATCH para economizar requisições.
 */
function despacharParaWorkerBackground(payload, jobsCriados = []) {
  // 1. Persistência Online imediata no Firebase `/fila_studio` (funciona mesmo com PC desligado)
  const listaJobs = Array.isArray(jobsCriados) ? jobsCriados.filter(j => j && j.id) : [];
  if (listaJobs.length === 1) {
    persistirJobFirebaseBackground(listaJobs[0]);
  } else if (listaJobs.length > 1 && isAdminAutenticado() && typeof fetch === "function" && FIREBASE_RTDB_URL && !FIREBASE_RTDB_URL.includes("SEU-PROJETO")) {
    const authParam = getFirebaseParamAuth();
    const urlPatch = `${FIREBASE_RTDB_URL.replace(/\/+$/, "")}/fila_studio.json${authParam}`;
    const TAMANHO_LOTE = 200;
    for (let i = 0; i < listaJobs.length; i += TAMANHO_LOTE) {
      const fatia = listaJobs.slice(i, i + TAMANHO_LOTE);
      const mapaPatch = {};
      fatia.forEach(j => {
        mapaPatch[j.id] = compactarJobParaFirebase(j);
      });
      fetch(urlPatch, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapaPatch)
      }).catch(() => {});
    }
    agendarAtualizacaoFilaStudioMetaBackground();
  }

  if (typeof fetch !== "function") return;
  const url = `${getStudioWorkerUrl()}/api/studio/enfileirar`;

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      if (data && data.ok && Array.isArray(data.jobs_criados)) {
        _studioState.workerOnline = true;
        if (data.contadores?.cota_status) {
          _studioState.cotaStatus = data.contadores.cota_status;
        }
        persistirFilaLocalStorage();
        atualizarContadorStudioTopbarDOM();
      }
    })
    .catch(() => {
      // Worker local offline: o job continua salvo online no Firebase (`/fila_studio`) e no localStorage!
      _studioState.workerOnline = false;
    });
}

/**
 * Disparo Rápido Fire-and-Forget (1 Artefato de 1 Aula).
 * Executa actualización visual do botão e do contador em < 1ms!
 */
export function dispararArtefatoStudio({
  discId,
  aulaId,
  tipoArtefato,
  acao,
  btnEl = null
}) {
  if (!isAdminAutenticado()) return null;
  const state = store.getState();
  let semEncontrado = null;
  let disc = null;
  let aula = null;

  for (const sem of (state.db?.semestres || [])) {
    for (const d of (sem.disciplinas || [])) {
      if (d.id === discId) {
        semEncontrado = sem;
        disc = d;
        aula = (d.aulas || []).find(a => a.id === aulaId) || null;
        break;
      }
    }
    if (disc) break;
  }

  const inspecao = inspecionarArtefatosExistentesAula(aula || { id: aulaId });
  const infoTipo = inspecao.porTipo[tipoArtefato] || {};
  const acaoFinal = acao || infoTipo.acao || "gerar";

  const itemPayload = {
    semestre_id: semEncontrado?.id || "",
    semestre_nome: semEncontrado?.nome || "",
    materia_id: discId,
    materia_nome: disc?.nome || discId,
    aula_id: aulaId,
    aula_nome: aula?.nome || aulaId,
    aula_titulo: aula ? obterTituloAula(aula, state.cacheMarkdownTexto) : aulaId,
    pasta_aula: aula?.local || "",
    notebook_url: aula?.linkNotebookLLM || "",
    tipo_artefato: tipoArtefato,
    acao: acaoFinal,
    url_antiga: infoTipo.urlAntiga || ""
  };

  const jobCriado = registrarJobOtimistaLocal(itemPayload);
  persistirFilaLocalStorage();

  // Feedback visual instantâneo no botão clicado e no contador do topo (0ms lag)
  const targetBtn = btnEl || (typeof document !== "undefined" ? document.getElementById(`studio-btn-${aulaId}-${tipoArtefato}`) : null);
  aplicarEstadoVisualBotaoStudio(targetBtn, jobCriado?.status || "na_fila");
  atualizarContadorStudioTopbarDOM();

  // Despacha sem await para Firebase + Worker local
  despacharParaWorkerBackground(
    { ...itemPayload, id: jobCriado?.id, config_geracao: jobCriado?.config_geracao },
    jobCriado ? [jobCriado] : []
  );
  return jobCriado;
}

/**
 * Disparo Rápido de TODOS os artefatos de uma aula (`⚡ Gerar Todos da Aula`).
 */
export function dispararTodosArtefatosDaAula({ discId, aulaId, apenasFaltantes = false, btnEl = null }) {
  if (!isAdminAutenticado()) return [];
  const state = store.getState();
  let semEncontrado = null;
  let disc = null;
  let aula = null;

  for (const sem of (state.db?.semestres || [])) {
    for (const d of (sem.disciplinas || [])) {
      if (d.id === discId) {
        semEncontrado = sem;
        disc = d;
        aula = (d.aulas || []).find(a => a.id === aulaId) || null;
        break;
      }
    }
    if (disc) break;
  }

  const inspecao = inspecionarArtefatosExistentesAula(aula || { id: aulaId });
  const itensParaEnfileirar = [];
  const jobsCriados = [];

  ORDEM_EXECUCAO_ARTEFATOS_STUDIO.forEach(tipoId => {
    const meta = MAPA_TIPOS_STUDIO[tipoId];
    if (!meta) return;
    const info = inspecao.porTipo[meta.id];
    if (apenasFaltantes && info?.existe) return;

    const itemPayload = {
      semestre_id: semEncontrado?.id || "",
      semestre_nome: semEncontrado?.nome || "",
      materia_id: discId,
      materia_nome: disc?.nome || discId,
      aula_id: aulaId,
      aula_nome: aula?.nome || aulaId,
      aula_titulo: aula ? obterTituloAula(aula, state.cacheMarkdownTexto) : aulaId,
      pasta_aula: aula?.local || "",
      notebook_url: aula?.linkNotebookLLM || "",
      tipo_artefato: meta.id,
      acao: info?.existe ? "regerar" : "gerar",
      url_antiga: info?.urlAntiga || ""
    };

    const job = registrarJobOtimistaLocal(itemPayload);
    if (job) {
      jobsCriados.push(job);
      itensParaEnfileirar.push({ ...itemPayload, id: job.id, config_geracao: job.config_geracao });
    }

    if (typeof document !== "undefined") {
      const bTipo = document.getElementById(`studio-btn-${aulaId}-${meta.id}`);
      aplicarEstadoVisualBotaoStudio(bTipo, job?.status || "na_fila");
    }
  });

  if (btnEl) {
    aplicarEstadoVisualBotaoStudio(btnEl, "na_fila");
  }

  persistirFilaLocalStorage();
  atualizarContadorStudioTopbarDOM();

  if (itensParaEnfileirar.length > 0) {
    despacharParaWorkerBackground(
      { escopo: "all", itens: itensParaEnfileirar },
      jobsCriados
    );
  }

  return jobsCriados;
}

/**
 * Resolve e simula quais itens serão enfileirados em um disparo em lote,
 * suportando múltipla seleção de semestres (`semestreIds`), matérias (`materiaIds`)
 * e tipos de artefato (`tiposArtefato`).
 *
 * @param {{
 *   semestreIds?: string[] | 'todos' | null,
 *   materiaIds?: string[] | 'todas' | null,
 *   tiposArtefato?: string[] | 'todos',
 *   modoAcao?: 'regerar_existentes' | 'gerar_faltantes' | 'todos'
 * }} [opcoes]
 */
export function simularLoteStudio({
  semestreIds = null,
  materiaIds = "todas",
  tiposArtefato = "todos",
  modoAcao = "todos"
} = {}) {
  const state = store.getState();
  const tiposValidosSet = new Set(STUDIO_ARTIFACT_TYPES.map(t => t.id));
  let tiposLista = [];
  if (tiposArtefato === "todos") {
    tiposLista = [...ORDEM_EXECUCAO_ARTEFATOS_STUDIO];
  } else if (Array.isArray(tiposArtefato)) {
    tiposLista = Array.from(new Set(tiposArtefato.filter(t => tiposValidosSet.has(t))))
      .sort((a, b) => (MAPA_PRIORIDADE_ARTEFATO_STUDIO[a] || 99) - (MAPA_PRIORIDADE_ARTEFATO_STUDIO[b] || 99));
  } else if (typeof tiposArtefato === "string" && tiposValidosSet.has(tiposArtefato)) {
    tiposLista = [tiposArtefato];
  }

  if (tiposLista.length === 0) {
    return {
      totalTarefas: 0,
      totalGerar: 0,
      totalRegerar: 0,
      totalMaterias: 0,
      totalTipos: 0,
      itens: []
    };
  }

  const temFiltroSemestres = Array.isArray(semestreIds);
  const temFiltroMaterias = Array.isArray(materiaIds);
  const semSet = temFiltroSemestres ? new Set(semestreIds) : null;
  const matSet = temFiltroMaterias ? new Set(materiaIds) : null;

  const itens = [];
  const materiasIncluidas = new Set();
  let totalGerar = 0;
  let totalRegerar = 0;

  for (const sem of (state.db?.semestres || [])) {
    for (const disc of (sem.disciplinas || [])) {
      let incluirDisciplina = false;
      if (!temFiltroSemestres && !temFiltroMaterias) {
        incluirDisciplina = materiaIds === "todas" && (!semestreIds || semestreIds === "todos");
      } else if (temFiltroSemestres && !temFiltroMaterias) {
        incluirDisciplina = semSet.has(sem.id);
      } else if (!temFiltroSemestres && temFiltroMaterias) {
        incluirDisciplina = matSet.has(disc.id);
      } else {
        // Quando ambos os arrays são fornecidos, inclui a união (semestres selecionados + matérias selecionadas)
        incluirDisciplina = semSet.has(sem.id) || matSet.has(disc.id);
      }

      if (!incluirDisciplina) continue;
      materiasIncluidas.add(disc.id);

      for (const aula of (disc.aulas || [])) {
        // Ignora pasta artificial de materiais soltos
        if (String(aula.id).endsWith("-materiais-gerais")) continue;

        const inspecao = inspecionarArtefatosExistentesAula(aula);
        for (const tipo of tiposLista) {
          const info = inspecao.porTipo[tipo];
          if (!info) continue;

          if (modoAcao === "regerar_existentes" && !info.existe) continue;
          if (modoAcao === "gerar_faltantes" && info.existe) continue;

          const acao = info.existe ? "regerar" : "gerar";
          if (acao === "regerar") totalRegerar++;
          else totalGerar++;

          itens.push({
            materia_id: disc.id,
            materia_nome: disc.nome,
            semestre_id: sem.id,
            semestre_nome: sem.nome,
            aula_id: aula.id,
            aula_nome: aula.nome,
            aula_titulo: obterTituloAula(aula, state.cacheMarkdownTexto),
            pasta_aula: aula.local || "",
            notebook_url: aula.linkNotebookLLM || "",
            tipo_artefato: tipo,
            acao,
            url_antiga: info.urlAntiga || ""
          });
        }
      }
    }
  }

  itens.sort(compararJobsOrdemHierarquica);

  return {
    totalTarefas: itens.length,
    totalGerar,
    totalRegerar,
    totalMaterias: materiasIncluidas.size,
    totalTipos: tiposLista.length,
    itens
  };
}

/**
 * Disparo em Lote por Semestres, Matérias ou Geral (`📦 Regerar / Gerar Artefatos em Lote`).
 * Aceita múltipla seleção de semestres (`semestreIds`), matérias (`materiaIds`) e tipos (`tiposArtefato`).
 *
 * @param {{
 *   semestreIds?: string[] | 'todos' | null,
 *   materiaIds?: string[] | 'todas' | null,
 *   tiposArtefato?: string[] | 'todos',
 *   modoAcao?: 'regerar_existentes' | 'gerar_faltantes' | 'todos'
 * }} opcoes
 */
export function dispararLoteStudio({
  semestreIds = null,
  materiaIds = "todas",
  tiposArtefato = "todos",
  modoAcao = "todos"
} = {}) {
  if (!isAdminAutenticado()) return [];
  const simulacao = simularLoteStudio({ semestreIds, materiaIds, tiposArtefato, modoAcao });

  const itensBatch = [];
  const jobsCriados = [];

  for (const itemPayload of simulacao.itens) {
    const job = registrarJobOtimistaLocal(itemPayload);
    if (job) {
      jobsCriados.push(job);
      itensBatch.push({ ...itemPayload, id: job.id, config_geracao: job.config_geracao });
    }

    if (typeof document !== "undefined") {
      const bTipo = document.getElementById(`studio-btn-${itemPayload.aula_id}-${itemPayload.tipo_artefato}`);
      aplicarEstadoVisualBotaoStudio(bTipo, job?.status || "na_fila");
    }
  }

  persistirFilaLocalStorage();
  atualizarContadorStudioTopbarDOM();

  if (itensBatch.length > 0) {
    despacharParaWorkerBackground(
      { escopo: "batch_materia", itens: itensBatch },
      jobsCriados
    );
  }

  return jobsCriados;
}

/**
 * Sincroniza o estado da fila diretamente com o Firebase (`/fila_studio`),
 * verificando antes o nó leve `/fila_studio_meta.json` (~80 bytes) quando `forcar` for falso
 * para evitar baixar toda a fila sem alterações.
 * @param {{ forcar?: boolean }} [opcoes]
 */
export async function sincronizarFilaComFirebase({ forcar = false } = {}) {
  if (!isAdminAutenticado()) return false;
  if (typeof fetch !== "function" || !FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) {
    return false;
  }
  try {
    const authParam = getFirebaseParamAuth();
    const base = FIREBASE_RTDB_URL.replace(/\/+$/, "");

    let metaTsRemoto = null;
    let metaAcaoRemoto = "";
    if (!forcar) {
      try {
        const metaResp = await fetch(`${base}/fila_studio_meta.json${authParam}`, { cache: "no-store" });
        if (metaResp.ok) {
          const metaJson = await metaResp.json();
          if (metaJson && typeof metaJson === "object") {
            metaTsRemoto = Number(metaJson.atualizado_em || 0);
            metaAcaoRemoto = String(metaJson.acao || "").trim().toLowerCase();
          } else if (metaJson === null) {
            metaTsRemoto = 0;
          }
          if (metaTsRemoto !== null && _studioState.ultimoMetaFirebaseTs === metaTsRemoto) {
            return true;
          }
        }
      } catch (_) {}
    }

    const url = `${base}/fila_studio.json${authParam}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return false;
    const raw = await resp.json();
    if (metaTsRemoto !== null) {
      _studioState.ultimoMetaFirebaseTs = metaTsRemoto;
    }
    if (!raw || typeof raw !== "object") {
      // Se o Firebase retornou `null` (fila vazia), limpa jobs obsoletos locais
      // (preservando apenas disparos otimistas criados nos últimos 3s, salvo se for limpeza explícita).
      const agora = Date.now();
      const possuiOtimistaRecente =
        metaAcaoRemoto !== "limpar_fila" &&
        Array.from(_studioState.jobsMap.values()).some(j => (agora - Number(j.timestamp || 0)) < 3000);
      if (!possuiOtimistaRecente && _studioState.jobsMap.size > 0) {
        _studioState.jobsMap.clear();
        _studioState.cotaStatus = "OK";
        persistirFilaLocalStorage();
        atualizarContadorStudioTopbarDOM();
      }
      return true;
    }

    const novosJobs = new Map();
    let houveCotaPausada = false;

    Object.entries(raw).forEach(([jobId, j]) => {
      if (!j || typeof j !== "object") return;
      const item = { ...j, id: j.id || jobId };
      if (item.status === "cancelado_pendente_excluir" || item.status === "aprovado_pendente_mover") {
        return; // Oculta imediatamente da interface web enquanto aguarda limpeza física no Drive
      }
      if (item.status === "concluido" && item.auto_aprovado) {
        if (!_studioState.autoAprovadosProcessados.has(item.id)) {
          _studioState.autoAprovadosProcessados.add(item.id);
          aplicarArtefatoAprovadoNoStore(item);
        }
        return;
      }
      if (item.status !== "concluido") {
        if (item.status === "aguardando_cota") houveCotaPausada = true;
        novosJobs.set(item.id, item);
      }
    });

    // Preserva jobs locais que acabaram de ser criados se o Firebase ainda estiver vazio
    if (novosJobs.size > 0) {
      _studioState.jobsMap = novosJobs;
      _studioState.cotaStatus = houveCotaPausada ? "Pausada" : "OK";
      persistirFilaLocalStorage();
      atualizarContadorStudioTopbarDOM();
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Sincroniza o estado da fila com o `studio_worker.py` (GET /api/studio/fila)
 * e só consulta o Firebase caso o worker local esteja offline.
 * @param {{ forcar?: boolean }} [opcoes]
 */
export async function sincronizarFilaComWorker({ forcar = false } = {}) {
  if (!isAdminAutenticado()) return obterContadoresStudio();
  if (typeof fetch !== "function") return obterContadoresStudio();
  try {
    const resp = await fetch(`${getStudioWorkerUrl()}/api/studio/fila`, { cache: "no-store" });
    if (!resp.ok) {
      await sincronizarFilaComFirebase({ forcar });
      return obterContadoresStudio();
    }
    const data = await resp.json();
    if (data && data.ok && Array.isArray(data.jobs)) {
      _studioState.workerOnline = true;
      _studioState.cotaStatus = data.cota_status || "OK";

      const novosJobs = new Map();

      data.jobs.forEach(j => {
        if (!j || !j.id) return;
        if (j.status === "cancelado_pendente_excluir" || j.status === "aprovado_pendente_mover") {
          return;
        }
        if (j.status === "concluido" && j.auto_aprovado) {
          if (!_studioState.autoAprovadosProcessados.has(j.id)) {
            _studioState.autoAprovadosProcessados.add(j.id);
            aplicarArtefatoAprovadoNoStore(j);
          }
          return;
        }
        if (j.status !== "concluido") {
          novosJobs.set(j.id, j);
        }
      });

      _studioState.jobsMap = novosJobs;
      persistirFilaLocalStorage();
      atualizarContadorStudioTopbarDOM();
    }
  } catch (_) {
    _studioState.workerOnline = false;
    await sincronizarFilaComFirebase({ forcar });
  }
  return obterContadoresStudio();
}

/**
 * Injeta ou atualiza otimisticamente o arquivo aprovado dentro da aula no Store da SPA.
 */
export function aplicarArtefatoAprovadoNoStore(job) {
  if (!job) return false;
  const state = store.getState();
  if (!state.db || !Array.isArray(state.db.semestres)) return false;

  const tipo = job.tipo_artefato;
  const meta = MAPA_TIPOS_STUDIO[tipo];
  if (!meta) return false;

  for (const sem of state.db.semestres) {
    for (const disc of (sem.disciplinas || [])) {
      if (job.materia_id && disc.id !== job.materia_id) continue;
      for (const aula of (disc.aulas || [])) {
        if (aula.id !== job.aula_id) continue;

        const pastaRel = String(aula.local || job.pasta_aula || "").replace(/\\/g, "/").replace(/\/+$/, "");
        const nomePadrao = meta.nomePadrao;
        const localFinal = job.caminho_destino
          ? String(job.caminho_destino).replace(/\\/g, "/")
          : (pastaRel ? `${pastaRel}/${nomePadrao}` : nomePadrao);

        const driveIdAprovado = String(job.drive_id || job.staging_drive_id || "").trim();
        const textoEmbutido = job.conteudo_texto || job.conteudoTexto || "";
        const jsonEmbutido = job.conteudo_json || job.conteudoJson || null;

        const novoArq = {
          id: driveIdAprovado || `${aula.id}_${tipo}_${Date.now()}`,
          driveId: driveIdAprovado,
          nome: nomePadrao,
          tipo: meta.extensao,
          mimeType: tipo === "infografico" ? "image/png" : "",
          local: localFinal,
          conteudoTexto: textoEmbutido,
          conteudoJson: jsonEmbutido,
          temOCR: tipo === "slides" ? false : true,
          statusOCR: tipo === "slides" ? "sem_ocr" : "com_ocr",
          artifactRole: !meta.requerRevisao ? tipo : ""
        };

        if (!meta.requerRevisao) {
          if (!aula.artifacts || typeof aula.artifacts !== "object") {
            aula.artifacts = {};
          }
          aula.artifacts[tipo] = novoArq;
          aula[`${tipo}Url`] = localFinal;
        } else {
          if (!Array.isArray(aula.arquivos)) aula.arquivos = [];
          const idxExistente = aula.arquivos.findIndex(a => {
            if (!a) return false;
            return ehArquivoCorrespondenteTipoStudio(a, tipo) || String(a.nome || "").toLowerCase() === nomePadrao.toLowerCase();
          });
          if (idxExistente >= 0) {
            aula.arquivos[idxExistente] = novoArq;
          } else {
            aula.arquivos.push(novoArq);
          }
        }

        salvarDbCache(state.db);
        return true;
      }
    }
  }
  return false;
}

// ==============================================================================
// 👁️ AS 3 AÇÕES ESTRITAS DO PAINEL DE APROVAÇÃO (FASE 3)
// ==============================================================================

/**
 * 1. `[✅ Aprovar]`:
 * Atualiza imediatamente no Store/Firebase (marcando `aprovado_pendente_mover` se
 * o worker local estiver desligado, para que mova no Drive ao ligar) e remove
 * o card da lista de revisão.
 */
export async function aprovarJobRevisaoStudio(jobId) {
  if (!isAdminAutenticado()) return { ok: false, erro: "Autenticação de administrador necessária." };
  const job = _studioState.jobsMap.get(jobId);
  let workerRespondeu = false;

  if (job) {
    aplicarArtefatoAprovadoNoStore(job);
    _studioState.jobsMap.delete(jobId);
    persistirFilaLocalStorage();
    atualizarContadorStudioTopbarDOM();
  }

  if (typeof fetch === "function") {
    try {
      const resp = await fetch(`${getStudioWorkerUrl()}/api/studio/revisao/${encodeURIComponent(jobId)}/aprovar`, {
        method: "POST"
      });
      if (resp.ok) workerRespondeu = true;
    } catch (_) {}
  }

  // Se o PC com o worker estiver desligado, marca no Firebase para mover o arquivo físico no Drive ao ligar
  if (!workerRespondeu && job) {
    persistirJobFirebaseBackground({
      ...job,
      status: "aprovado_pendente_mover",
      aprovado_em: Date.now()
    });
  }

  return { ok: true, jobId, status_remoto: workerRespondeu ? "concluido" : "aprovado_pendente_mover" };
}

/**
 * 2. `[🔄 Tentar de Novo]`:
 * Marca `limpar_staging_anterior: true` no Firebase e volta o status para `na_fila`
 * (se o PC estiver desligado, o worker limpa o arquivo antigo do Drive ao ligar e regera).
 */
export async function tentarNovamenteJobRevisaoStudio(jobId) {
  if (!isAdminAutenticado()) return { ok: false, erro: "Autenticação de administrador necessária." };
  const job = _studioState.jobsMap.get(jobId);
  let workerRespondeu = false;

  if (job) {
    job.status = "na_fila";
    job.limpar_staging_anterior = true;
    job.timestamp = Date.now();
    _studioState.jobsMap.set(jobId, job);
    persistirFilaLocalStorage();
    atualizarContadorStudioTopbarDOM();
  }

  if (typeof fetch === "function") {
    try {
      const resp = await fetch(`${getStudioWorkerUrl()}/api/studio/revisao/${encodeURIComponent(jobId)}/tentar-novamente`, {
        method: "POST"
      });
      if (resp.ok) workerRespondeu = true;
    } catch (_) {}
  }

  if (!workerRespondeu && job) {
    persistirJobFirebaseBackground(job);
  }

  return { ok: true, jobId, status: "na_fila" };
}

/**
 * 3. `[✖]` (Botão X no canto do card):
 * Remove imediatamente da lista de revisão, mantendo o arquivo antigo intacto.
 * Se o PC principal estiver desligado, grava `cancelado_pendente_excluir` no Firebase
 * para que o worker apague o arquivo de staging do Google Drive assim que ligar.
 */
export async function cancelarJobRevisaoStudio(jobId) {
  if (!isAdminAutenticado()) return { ok: false, erro: "Autenticação de administrador necessária." };
  const jobAnterior = _studioState.jobsMap.get(jobId);
  let workerRespondeu = false;

  _studioState.jobsMap.delete(jobId);
  persistirFilaLocalStorage();
  atualizarContadorStudioTopbarDOM();

  if (typeof fetch === "function") {
    try {
      const resp = await fetch(`${getStudioWorkerUrl()}/api/studio/revisao/${encodeURIComponent(jobId)}`, {
        method: "DELETE"
      });
      if (resp.ok) workerRespondeu = true;
    } catch (_) {}
  }

  if (!workerRespondeu && jobAnterior) {
    persistirJobFirebaseBackground({
      ...jobAnterior,
      status: "cancelado_pendente_excluir",
      cancelado_em: Date.now()
    });
  }

  return { ok: true, jobId, cancelado: true, status_remoto: workerRespondeu ? "removido" : "cancelado_pendente_excluir" };
}

/**
 * Simula ou registra pausa por limite de cota (Guardião de Cota Persistente).
 */
export function pausarFilaPorCotaStudio(motivo = "Limite de cota atingido no Google NotebookLM") {
  _studioState.cotaStatus = "Pausada";
  for (const job of _studioState.jobsMap.values()) {
    if (job.status === "na_fila" || job.status === "gerando") {
      job.status = "aguardando_cota";
      job.erro_log = motivo;
    }
  }
  persistirFilaLocalStorage();
  atualizarContadorStudioTopbarDOM();
}

/**
 * Retoma automaticamente todos os itens que estavam em `aguardando_cota` para `na_fila`.
 */
export async function retomarFilaCotaStudio() {
  if (!isAdminAutenticado()) return { ok: false, retomados: 0, erro: "Autenticação de administrador necessária." };
  _studioState.cotaStatus = "OK";
  let retomados = 0;
  for (const job of _studioState.jobsMap.values()) {
    if (job.status === "aguardando_cota") {
      job.status = "na_fila";
      job.erro_log = "";
      retomados++;
    }
  }
  persistirFilaLocalStorage();
  atualizarContadorStudioTopbarDOM();

  if (typeof fetch === "function") {
    try {
      await fetch(`${getStudioWorkerUrl()}/api/studio/retomar-cota`, { method: "POST" });
    } catch (_) {}
  }

  return { ok: true, retomados };
}

function montarUrlFirebaseComQuery(base, pathJson, authParam = "", extraQuery = "") {
  const qsPartes = [];
  if (extraQuery) qsPartes.push(extraQuery.replace(/^[?&]+/, ""));
  if (authParam) qsPartes.push(authParam.replace(/^[?&]+/, ""));
  const qs = qsPartes.length > 0 ? `?${qsPartes.join("&")}` : "";
  return `${base}/${pathJson.replace(/^\/+/, "")}${qs}`;
}

/**
 * Apaga 100% dos jobs de `/fila_studio` no Firebase RTDB via `GET ?shallow=true` +
 * `PATCH /fila_studio.json` em lotes de 200 chaves com `{ [id]: null }` (compatível com
 * as regras de segurança por `$job_id`, onde `DELETE /fila_studio.json` retorna 401),
 * e faz verificação final garantindo 0 itens restantes.
 * @param {string[]} [chavesExtras]
 */
async function limparFilaFirebaseDireto(chavesExtras = []) {
  if (typeof fetch !== "function" || !FIREBASE_RTDB_URL || FIREBASE_RTDB_URL.includes("SEU-PROJETO")) {
    return { ok: false, removidos_firebase: 0, restantes_firebase: -1 };
  }
  const authParam = getFirebaseParamAuth();
  const base = FIREBASE_RTDB_URL.replace(/\/+$/, "");
  const urlShallow = montarUrlFirebaseComQuery(base, "fila_studio.json", authParam, "shallow=true");
  const urlFila = montarUrlFirebaseComQuery(base, "fila_studio.json", authParam);
  const urlMeta = montarUrlFirebaseComQuery(base, "fila_studio_meta.json", authParam);
  const extras = Array.isArray(chavesExtras) ? chavesExtras.map(k => String(k || "").trim()).filter(Boolean) : [];

  let totalRemovidos = 0;

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let okList = false;
    let chavesRemotas = [];
    try {
      const respShallow = await fetch(urlShallow, { cache: "no-store" });
      if (respShallow.ok) {
        okList = true;
        const dados = await respShallow.json();
        if (dados && typeof dados === "object") {
          chavesRemotas = Object.keys(dados);
        }
      }
    } catch (_) {}

    const conjunto = new Set(tentativa === 0 ? [...chavesRemotas, ...extras] : chavesRemotas);
    const chavesAlvo = Array.from(conjunto);
    if (chavesAlvo.length === 0) {
      if (okList) break;
      return { ok: false, removidos_firebase: totalRemovidos, restantes_firebase: -1 };
    }

    const TAMANHO_LOTE = 200;
    for (let i = 0; i < chavesAlvo.length; i += TAMANHO_LOTE) {
      const fatia = chavesAlvo.slice(i, i + TAMANHO_LOTE);
      const mapaNulos = {};
      fatia.forEach(k => { mapaNulos[k] = null; });
      let loteOk = false;
      try {
        const respPatch = await fetch(urlFila, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mapaNulos)
        });
        if (respPatch.ok) {
          loteOk = true;
          totalRemovidos += fatia.length;
        }
      } catch (_) {}

      if (!loteOk) {
        for (const k of fatia) {
          try {
            const respDel = await fetch(
              montarUrlFirebaseComQuery(base, `fila_studio/${encodeURIComponent(k)}.json`, authParam),
              { method: "DELETE" }
            );
            if (respDel.ok) totalRemovidos++;
          } catch (_) {}
        }
      }
    }
  }

  let okVerif = false;
  let restantes = -1;
  try {
    const respVerif = await fetch(urlShallow, { cache: "no-store" });
    if (respVerif.ok) {
      okVerif = true;
      const restoObj = await respVerif.json();
      restantes = restoObj && typeof restoObj === "object" ? Object.keys(restoObj).length : 0;
    }
  } catch (_) {}

  const agora = Date.now();
  _studioState.ultimoMetaFirebaseTs = agora;
  try {
    const respMeta = await fetch(urlMeta, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atualizado_em: agora,
        acao: "limpar_fila",
        limpo_em: agora,
        admin_gate: STUDIO_ADMIN_GATE
      })
    });
    if (!respMeta.ok) {
      await fetch(urlMeta, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atualizado_em: agora, admin_gate: STUDIO_ADMIN_GATE })
      });
    }
  } catch (_) {}

  return {
    ok: okVerif && restantes === 0,
    removidos_firebase: totalRemovidos,
    restantes_firebase: restantes
  };
}

/**
 * Limpa completamente todos os jobs da fila local, do worker local (`POST /api/studio/limpar-fila`)
 * e do nó remoto `/fila_studio` no Firebase RTDB (com verificação de 0 itens restantes).
 */
export async function limparFilaStudioCompleta() {
  if (!isAdminAutenticado()) return { ok: false, erro: "Autenticação de administrador necessária." };
  const idsLocais = Array.from(_studioState.jobsMap.keys());
  limparFilaStudioLocal();

  let workerLimpo = false;
  let firebaseLimpo = false;
  let removidosFirebase = 0;
  let restantesFirebase = 0;

  if (typeof fetch === "function") {
    try {
      const resp = await fetch(`${getStudioWorkerUrl()}/api/studio/limpar-fila`, { method: "POST" });
      if (resp.ok) {
        workerLimpo = true;
        try {
          const workerData = await resp.json();
          if (workerData && typeof workerData === "object") {
            removidosFirebase = Number(workerData.removidos_firebase || 0);
            restantesFirebase = Number(workerData.restantes_firebase ?? -1);
            firebaseLimpo = Boolean(workerData.firebase_limpo && restantesFirebase === 0);
          }
        } catch (_) {}
      }
    } catch (_) {}

    if (!firebaseLimpo && FIREBASE_RTDB_URL && !FIREBASE_RTDB_URL.includes("SEU-PROJETO")) {
      const resFb = await limparFilaFirebaseDireto(idsLocais);
      firebaseLimpo = resFb.ok;
      removidosFirebase = Math.max(removidosFirebase, resFb.removidos_firebase);
      restantesFirebase = resFb.restantes_firebase;
    }
  }

  return {
    ok: true,
    worker_limpo: workerLimpo,
    firebase_limpo: firebaseLimpo,
    removidos_local: idsLocais.length,
    removidos_firebase: removidosFirebase,
    restantes_firebase: restantesFirebase
  };
}

/**
 * Consulta sob demanda o Relatório de Fontes de uma aula (`GET /api/studio/fontes`).
 */
export async function consultarRelatorioFontesNotebook({ notebookUrl, materiaId, aulaId }) {
  const qs = new URLSearchParams({
    notebook_url: notebookUrl || "",
    materia_id: materiaId || "",
    aula_id: aulaId || ""
  });
  const resp = await fetch(`${getStudioWorkerUrl()}/api/studio/fontes?${qs.toString()}`, {
    cache: "no-store"
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ao consultar fontes no Studio Worker.`);
  }
  return resp.json();
}

/**
 * Renderiza a barra de botões "Fire-and-Forget" de uma aula para o Administrador,
 * baseada estritamente no que já consta no `db.json` (Regra de Ouro Nº 1).
 */
export function renderBarraStudioAulaAdminHtml(disc, aula) {
  if (!disc || !aula) return "";
  const inspecao = inspecionarArtefatosExistentesAula(aula);

  const botoesIndividuaisHtml = STUDIO_ARTIFACT_TYPES.map(meta => {
    const info = inspecao.porTipo[meta.id];
    const jobAtivo = info.jobAtivo;
    const btnId = `studio-btn-${aula.id}-${meta.id}`;

    if (jobAtivo) {
      let labelStatus = "⏳ Na Fila";
      let corStatus = "bg-amber-500/20 text-amber-200 border-amber-400/50 cursor-wait";
      if (jobAtivo.status === "gerando") {
        labelStatus = "⚙️ Gerando...";
        corStatus = "bg-indigo-500/25 text-indigo-200 border-indigo-400/50 cursor-wait";
      } else if (jobAtivo.status === "aguardando_cota") {
        labelStatus = "⏸️ Aguardando Cota";
        corStatus = "bg-rose-500/20 text-rose-200 border-rose-400/50 cursor-help";
      } else if (jobAtivo.status === "revisao") {
        labelStatus = "👁️ Em Revisão";
        corStatus = "bg-emerald-500/20 text-emerald-200 border-emerald-400/50 cursor-pointer";
      }
      return `
        <button
          type="button"
          id="${escapeHtml(btnId)}"
          data-studio-status="${escapeHtml(jobAtivo.status)}"
          onclick="window.StudyOS?.abrirModalStudioRevisao()"
          title="${escapeHtml(meta.labelCompleto)} — Status: ${escapeHtml(jobAtivo.status)}"
          class="px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold border transition-all flex items-center gap-1 shadow-xs ${corStatus}"
        >
          <span>${labelStatus}</span>
          <span class="opacity-75">(${escapeHtml(meta.labelCurto)})</span>
        </button>
      `;
    }

    const classesBtn = info.existe
      ? "bg-notion-card hover:bg-indigo-600/25 text-indigo-200 hover:text-white border-indigo-500/35 hover:border-indigo-400"
      : "bg-emerald-500/15 hover:bg-emerald-600/30 text-emerald-200 hover:text-white border-emerald-500/40 hover:border-emerald-400";

    const badgeAuto = !meta.requerRevisao
      ? `<span class="text-[9px] px-1 py-0.2 rounded bg-black/40 text-cyan-300" title="Artefato não-visual: vai direto sem precisar de aprovação">Direto</span>`
      : "";

    return `
      <button
        type="button"
        id="${escapeHtml(btnId)}"
        data-studio-btn="true"
        data-disc-id="${escapeHtml(disc.id)}"
        data-aula-id="${escapeHtml(aula.id)}"
        data-tipo-artefato="${escapeHtml(meta.id)}"
        data-acao="${escapeHtml(info.acao)}"
        onclick="event.stopPropagation(); window.StudyOS?.dispararArtefatoStudio('${escapeHtml(disc.id)}', '${escapeHtml(aula.id)}', '${escapeHtml(meta.id)}', '${escapeHtml(info.acao)}', this)"
        title="${escapeHtml(info.textoBotao)} (${escapeHtml(meta.labelCompleto)})"
        class="px-2.5 py-1 rounded-lg text-[11px] font-mono font-medium border transition-all flex items-center gap-1.5 cursor-pointer shadow-xs ${classesBtn}"
      >
        <span>${escapeHtml(info.textoBotao)}</span>
        ${badgeAuto}
      </button>
    `;
  }).join("");

  const btnGerarTodosAulaHtml = !inspecao.possuiAlgumArtefato
    ? `
      <button
        type="button"
        id="studio-btn-all-${escapeHtml(aula.id)}"
        data-studio-all-btn="true"
        onclick="event.stopPropagation(); window.StudyOS?.dispararTodosArtefatosDaAula('${escapeHtml(disc.id)}', '${escapeHtml(aula.id)}', false, this)"
        class="px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-black font-mono font-extrabold text-xs shadow-md transition-all flex items-center gap-1.5 cursor-pointer shrink-0"
        title="Esta aula não possui nenhum artefato cadastrado no db.json — Clique para gerar todos os 8 artefatos de uma vez!"
      >
        <span>⚡ Gerar Todos da Aula</span>
      </button>
    `
    : inspecao.totalFaltantes > 0
      ? `
        <button
          type="button"
          id="studio-btn-missing-${escapeHtml(aula.id)}"
          onclick="event.stopPropagation(); window.StudyOS?.dispararTodosArtefatosDaAula('${escapeHtml(disc.id)}', '${escapeHtml(aula.id)}', true, this)"
          class="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 text-amber-200 border border-amber-500/40 font-mono font-bold text-[11px] transition-all flex items-center gap-1 cursor-pointer shrink-0"
          title="Enfileirar apenas os ${inspecao.totalFaltantes} artefatos que ainda faltam nesta aula"
        >
          <span>⚡ Gerar Faltantes (${inspecao.totalFaltantes})</span>
        </button>
      `
      : "";

  return `
    <div class="p-3.5 rounded-2xl bg-gradient-to-r from-indigo-950/50 via-notion-bg to-purple-950/40 border border-indigo-500/35 space-y-2.5 shadow-sm" data-studio-lesson-bar="${escapeHtml(aula.id)}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/35 font-mono font-bold text-[10px] uppercase tracking-wider">
            ⚡ Studio Worker (Fire-and-Forget)
          </span>
          <span class="text-[11px] font-mono text-notion-muted">
            Existentes no DB: <strong class="text-white">${inspecao.totalExistentes}/8</strong>
          </span>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          ${btnGerarTodosAulaHtml}
          <button
            type="button"
            onclick="event.stopPropagation(); window.StudyOS?.abrirModalFontesNotebook('${escapeHtml(disc.id)}', '${escapeHtml(aula.id)}')"
            class="px-2.5 py-1 rounded-lg bg-notion-card hover:bg-cyan-600/25 text-cyan-300 hover:text-white border border-cyan-500/35 font-mono text-[11px] transition-all flex items-center gap-1 cursor-pointer shrink-0"
            title="Consultar/Editar Relatório de Fontes do Caderno no NotebookLM sob demanda e salvar no db.json"
          >
            <span>📑 Relatório de Fontes</span>
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-white/5">
        ${botoesIndividuaisHtml}
      </div>
    </div>
  `;
}

/**
 * Inicia o polling leve em background (a cada 15 segundos) apenas quando em Modo Admin
 * e com a aba visível, evitando tráfego ocioso no Firebase.
 */
export function iniciarMonitoramentoStudioBackground() {
  if (_studioState.pollingTimer) return;
  atualizarContadorStudioTopbarDOM();
  _studioState.pollingTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    sincronizarFilaComWorker();
  }, 15000);
  if (typeof _studioState.pollingTimer?.unref === "function") {
    _studioState.pollingTimer.unref();
  }
}
