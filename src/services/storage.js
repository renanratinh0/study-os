/**
 * Study OS V2 - Storage Service
 * Abstração de persistência em LocalStorage com tratamento defensivo
 * de cotas excedidas, modos de navegação anônima e parsing de erros.
 */

import { STORAGE_KEYS, DEFAULT_MEDIA_PATH, DEFAULT_THEME } from "../core/constants.js";

// Memória volátil para ambientes sem localStorage (ex: Node.js tests)
let _memTheme = DEFAULT_THEME;

/**
 * Salva o banco de dados completo no cache do navegador.
 * @param {object} dbJson
 */
export function salvarDbCache(dbJson) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.DB_CACHE, JSON.stringify(dbJson));
    }
  } catch (err) {
    console.warn("[Storage] Falha ao salvar DB em cache:", err);
  }
}

/**
 * Recupera o banco de dados salvo em cache no navegador.
 * @returns {object | null}
 */
export function obterDbCache() {
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
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEYS.DB_CACHE);
    }
  } catch (_) {}
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
  } catch (_) {}
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
  } catch (_) {}
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
  } catch (_) {}
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
  } catch (_) {}
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
  } catch (_) {}
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
  } catch (_) {}
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
