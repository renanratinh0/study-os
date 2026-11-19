/**
 * Study OS V2 - Storage Service
 * Abstração de persistência em LocalStorage com tratamento defensivo
 * de cotas excedidas, modos de navegação anônima e parsing de erros.
 */

import { STORAGE_KEYS, DEFAULT_MEDIA_PATH, DEFAULT_THEME } from "../core/constants.js";

// Memória volátil para ambientes sem localStorage (ex: Node.js tests) e bancos > quota
let _memTheme = DEFAULT_THEME;
let _memDbCache = null;
let _memFlashcardsSrs = {};
let _memQuizProgress = {};

const MAX_LOCALSTORAGE_DB_CHARS = 3_800_000;

function compactarNoCache(valor) {
  if (Array.isArray(valor)) {
    return valor.map(compactarNoCache);
  }
  if (!valor || typeof valor !== "object") {
    return valor;
  }
  const out = {};
  for (const [k, v] of Object.entries(valor)) {
    if (k === "conteudoJson") continue;
    if (k === "conteudoTexto" && typeof v === "string" && v.length > 512) continue;
    out[k] = compactarNoCache(v);
  }
  return out;
}

/**
 * Gera uma cópia compactada do banco omitindo conteúdos inline pesados (> 512 chars)
 * para caber na cota do localStorage sem gerar QuotaExceededError.
 * @param {object} dbJson
 * @returns {object}
 */
export function compactarDbParaCacheLeve(dbJson) {
  return compactarNoCache(dbJson);
}

/**
 * Salva o banco de dados em memória e no cache leve do navegador sem estourar cota.
 * @param {object} dbJson
 */
export function salvarDbCache(dbJson) {
  _memDbCache = dbJson || null;
  if (typeof localStorage === "undefined" || !dbJson) return;

  try {
    const serializado = JSON.stringify(dbJson);
    if (serializado.length <= MAX_LOCALSTORAGE_DB_CHARS) {
      localStorage.setItem(STORAGE_KEYS.DB_CACHE, serializado);
      return;
    }
  } catch (_) {
    // Continua para tentativa compactada em caso de QuotaExceededError
  }

  try {
    const leve = JSON.stringify(compactarDbParaCacheLeve(dbJson));
    localStorage.setItem(STORAGE_KEYS.DB_CACHE, leve);
  } catch (_) {
    try {
      localStorage.removeItem(STORAGE_KEYS.DB_CACHE);
    } catch (_) { }
  }
}

/**
 * Recupera o banco de dados salvo em cache em memória ou no navegador.
 * @returns {object | null}
 */
export function obterDbCache() {
  if (_memDbCache) return _memDbCache;
  try {
    if (typeof localStorage !== "undefined") {
      const salvo = localStorage.getItem(STORAGE_KEYS.DB_CACHE);
      return salvo ? JSON.parse(salvo) : null;
    }
  } catch (err) {
    console.warn("[Storage] Falha ao ler DB do cache:", err);
  }
  return null;
}

/**
 * Remove o banco salvo do cache.
 */
export function limparDbCache() {
  _memDbCache = null;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEYS.DB_CACHE);
    }
  } catch (_) { }
}

/**
 * Salva uma edição de Markdown localmente.
 * @param {string} cacheKey
 * @param {string} novoTexto
 */
export function salvarEdicaoMdCache(cacheKey, novoTexto) {
  try {
    if (typeof localStorage !== "undefined") {
      const atual = obterEdicoesMdCache();
      atual[cacheKey] = novoTexto;
      localStorage.setItem(STORAGE_KEYS.MD_EDITS_CACHE, JSON.stringify(atual));
    }
  } catch (err) {
    console.warn("[Storage] Falha ao persistir edição MD:", err);
  }
}

/**
 * Retorna todas as edições locais salvas para arquivos Markdown.
 * @returns {Record<string, string>}
 */
export function obterEdicoesMdCache() {
  try {
    if (typeof localStorage !== "undefined") {
      const salvo = localStorage.getItem(STORAGE_KEYS.MD_EDITS_CACHE);
      return salvo ? JSON.parse(salvo) : {};
    }
  } catch (_) { }
  return {};
}

/**
 * Limpa o histórico de edições locais de Markdown.
 */
export function limparEdicoesMdCache() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEYS.MD_EDITS_CACHE);
    }
  } catch (_) { }
}

/**
 * Retorna o caminho base configurado para mídias locais.
 * @returns {string}
 */
export function obterBaseMediaPath() {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(STORAGE_KEYS.BASE_MEDIA_PATH) || DEFAULT_MEDIA_PATH;
    }
  } catch (_) { }
  return DEFAULT_MEDIA_PATH;
}

/**
 * Atualiza o caminho base configurado para mídias locais.
 * @param {string} path
 */
export function salvarBaseMediaPath(path) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.BASE_MEDIA_PATH, String(path || "").trim() || DEFAULT_MEDIA_PATH);
    }
  } catch (_) { }
}

/**
 * Obtém o tema atual preferido. O tema padrão é SEMPRE "dark" (escuro),
 * nunca sendo sobrescrito automaticamente pelo tema do sistema operacional.
 * @returns {'dark' | 'light'}
 */
export function obterTemaPreferido() {
  try {
    if (typeof localStorage !== "undefined") {
      const salvo = localStorage.getItem(STORAGE_KEYS.THEME);
      if (salvo === "light" || salvo === "dark") {
        return salvo;
      }
      return DEFAULT_THEME;
    }
  } catch (_) { }
  return _memTheme === "light" ? "light" : DEFAULT_THEME;
}

/**
 * Salva a preferência de tema ("dark" ou "light"), mantendo "dark" como fallback seguro.
 * @param {'dark' | 'light'} tema
 * @returns {'dark' | 'light'}
 */
export function salvarTemaPreferido(tema) {
  const temaNormalizado = tema === "light" ? "light" : DEFAULT_THEME;
  _memTheme = temaNormalizado;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.THEME, temaNormalizado);
    }
  } catch (_) { }
  return temaNormalizado;
}

/**
 * Aplica a classe de tema ('dark' ou 'light') na tag <html>, atualiza os botões de toggle
 * e sincroniza automaticamente os logotipos com atributos data-logo-dark / data-logo-light.
 * @param {'dark' | 'light'} [tema]
 * @returns {'dark' | 'light'}
 */
export function aplicarTemaNoDocumento(tema = obterTemaPreferido()) {
  const temaFinal = tema === "light" ? "light" : DEFAULT_THEME;
  if (typeof document !== "undefined" && document.documentElement) {
    const root = document.documentElement;
    if (temaFinal === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
      root.setAttribute("data-theme", "light");
    } else {
      root.classList.add("dark");
      root.classList.remove("light");
      root.setAttribute("data-theme", "dark");
    }

    const iconEl = document.getElementById("theme-toggle-icon");
    const labelEl = document.getElementById("theme-toggle-label");
    if (iconEl) iconEl.textContent = temaFinal === "light" ? "☀️" : "🌙";
    if (labelEl) labelEl.textContent = temaFinal === "light" ? "Claro" : "Escuro";

    if (typeof document.querySelectorAll === "function") {
      document.querySelectorAll("[data-logo-dark][data-logo-light]").forEach(img => {
        const novoSrc = temaFinal === "light"
          ? img.getAttribute("data-logo-light")
          : img.getAttribute("data-logo-dark");
        if (novoSrc) img.setAttribute("src", novoSrc);
      });
    }
  }
  return temaFinal;
}

/**
 * Alterna entre o Modo Escuro (padrão) e o Modo Claro, persistindo a escolha.
 * @returns {'dark' | 'light'} O novo tema aplicado.
 */
export function alternarTema() {
  const atual = obterTemaPreferido();
  const proximo = atual === "dark" ? "light" : "dark";
  salvarTemaPreferido(proximo);
  return aplicarTemaNoDocumento(proximo);
}

// ==============================================================================
// 🃏 PERSISTÊNCIA DE PROGRESSO: FLASHCARDS (SRS) & QUIZ SIMULADOR (CAMADAS 7 & 8)
// ==============================================================================

function lerMapaStorageSeguro(key, fallbackMem) {
  try {
    if (typeof localStorage !== "undefined") {
      const salvo = localStorage.getItem(key);
      return salvo ? JSON.parse(salvo) : {};
    }
  } catch (err) {
    console.warn(`[Storage] Falha ao ler ${key}:`, err);
  }
  return { ...fallbackMem };
}

function gravarMapaStorageSeguro(key, dados) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, JSON.stringify(dados));
    }
  } catch (err) {
    console.warn(`[Storage] Falha ao gravar ${key}:`, err);
  }
}

/**
 * Retorna o progresso SRS salvo dos flashcards para uma aula específica.
 * @param {string} lessonId
 * @returns {Record<string, { rating: 'hard' | 'medium' | 'easy', updatedAt: number, reviews: number }>}
 */
export function obterProgressoFlashcards(lessonId) {
  if (!lessonId) return {};
  const todos = lerMapaStorageSeguro(STORAGE_KEYS.FLASHCARDS_SRS, _memFlashcardsSrs);
  return { ...(todos[lessonId] || {}) };
}

/**
 * Salva a avaliação SRS de um card específico vinculada ao ID da aula.
 * @param {string} lessonId
 * @param {string} cardId
 * @param {'hard' | 'medium' | 'easy'} rating
 * @returns {Record<string, { rating: 'hard' | 'medium' | 'easy', updatedAt: number, reviews: number }>}
 */
export function salvarAvaliacaoFlashcard(lessonId, cardId, rating) {
  if (!lessonId || !cardId) return {};
  const validRating = ["hard", "medium", "easy"].includes(rating) ? rating : "medium";
  const todos = lerMapaStorageSeguro(STORAGE_KEYS.FLASHCARDS_SRS, _memFlashcardsSrs);
  const aulaAtual = { ...(todos[lessonId] || {}) };
  const anterior = aulaAtual[cardId] || { reviews: 0 };

  aulaAtual[cardId] = {
    rating: validRating,
    updatedAt: Date.now(),
    reviews: (Number(anterior.reviews) || 0) + 1
  };

  todos[lessonId] = aulaAtual;
  _memFlashcardsSrs = todos;
  gravarMapaStorageSeguro(STORAGE_KEYS.FLASHCARDS_SRS, todos);
  return { ...aulaAtual };
}

/**
 * Limpa todo o histórico SRS dos flashcards de uma aula.
 * @param {string} lessonId
 */
export function limparProgressoFlashcards(lessonId) {
  if (!lessonId) return;
  const todos = lerMapaStorageSeguro(STORAGE_KEYS.FLASHCARDS_SRS, _memFlashcardsSrs);
  delete todos[lessonId];
  _memFlashcardsSrs = todos;
  gravarMapaStorageSeguro(STORAGE_KEYS.FLASHCARDS_SRS, todos);
}

/**
 * Retorna o progresso e placar do Quiz salvo para uma aula específica.
 * @param {string} lessonId
 * @returns {{ answers: Record<string, { selectedIndex: number, isCorrect: boolean }>, score: number, total: number, updatedAt: number }}
 */
export function obterProgressoQuiz(lessonId) {
  const vazio = { answers: {}, score: 0, total: 0, updatedAt: 0 };
  if (!lessonId) return vazio;
  const todos = lerMapaStorageSeguro(STORAGE_KEYS.QUIZ_PROGRESS, _memQuizProgress);
  const salvo = todos[lessonId];
  if (!salvo || typeof salvo !== "object") return vazio;
  return {
    answers: { ...(salvo.answers || {}) },
    score: Number(salvo.score) || 0,
    total: Number(salvo.total) || 0,
    updatedAt: Number(salvo.updatedAt) || 0
  };
}

/**
 * Salva as respostas e o placar de acertos do Quiz de uma aula.
 * @param {string} lessonId
 * @param {{ answers: Record<string, { selectedIndex: number, isCorrect: boolean }>, score: number, total: number }} progresso
 */
export function salvarProgressoQuiz(lessonId, progresso) {
  if (!lessonId || !progresso) return;
  const todos = lerMapaStorageSeguro(STORAGE_KEYS.QUIZ_PROGRESS, _memQuizProgress);
  todos[lessonId] = {
    answers: { ...(progresso.answers || {}) },
    score: Number(progresso.score) || 0,
    total: Number(progresso.total) || 0,
    updatedAt: Date.now()
  };
  _memQuizProgress = todos;
  gravarMapaStorageSeguro(STORAGE_KEYS.QUIZ_PROGRESS, todos);
}

/**
 * Reinicia o progresso e placar do Quiz de uma aula.
 * @param {string} lessonId
 */
export function limparProgressoQuiz(lessonId) {
  if (!lessonId) return;
  const todos = lerMapaStorageSeguro(STORAGE_KEYS.QUIZ_PROGRESS, _memQuizProgress);
  delete todos[lessonId];
  _memQuizProgress = todos;
  gravarMapaStorageSeguro(STORAGE_KEYS.QUIZ_PROGRESS, todos);
}
