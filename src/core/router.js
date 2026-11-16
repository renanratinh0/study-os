/**
 * Study OS V2 - Lightweight Hash Router
 * Roteamento leve baseado em window.location.hash com suporte a parâmetros de rota
 * e ciclo de vida desacoplado de renderização.
 */

export class Router {
  constructor() {
    this.routes = new Map();
    this.currentRoute = null;
    this.currentParams = {};
    this.isListening = false;
  }

  /**
   * Registra uma rota com padrão de caminho e manipulador.
   * Ex: addRoute('/disciplina/:id', handler)
   * @param {string} pattern
   * @param {(params: Record<string, string>) => void} handler
   */
  addRoute(pattern, handler) {
    const keys = [];
    const regexPattern = pattern
      .replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      })
      .replace(/\//g, "\\/");

    const regex = new RegExp(`^#?${regexPattern}$`);
    this.routes.set(pattern, { regex, keys, handler });
    return this;
  }

  /**
   * Inicia os ouvintes do roteador.
   */
  init() {
    if (this.isListening) return;
    this.handleHashChange = () => this.resolve();
    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", this.handleHashChange);
      this.isListening = true;
      this.resolve();
    }
  }

  /**
   * Desconecta os ouvintes do roteador.
   */
  destroy() {
    if (this.isListening && typeof window !== "undefined") {
      window.removeEventListener("hashchange", this.handleHashChange);
      this.isListening = false;
    }
  }

  /**
   * Navega programaticamente para um hash.
   * @param {string} hash
   */
  navigate(hash) {
    const target = hash.startsWith("#") ? hash : `#${hash}`;
    if (typeof window !== "undefined") {
      window.location.hash = target;
    }
  }

  /**
   * Resolve a rota atual com base no hash do navegador.
   */
  resolve() {
    if (typeof window === "undefined") return;
    const rawHash = window.location.hash || "#/";
    const normalizedHash = rawHash.startsWith("#") ? rawHash : `#${rawHash}`;

    for (const [pattern, { regex, keys, handler }] of this.routes.entries()) {
      const match = normalizedHash.match(regex);
      if (match) {
        const params = {};
        keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1]);
        });
        this.currentRoute = pattern;
        this.currentParams = params;
        handler(params);
        return;
      }
    }

    // Rota fallback para home
    const homeRoute = this.routes.get("/") || this.routes.get("#/");
    if (homeRoute) {
      this.currentRoute = "/";
      this.currentParams = {};
      homeRoute.handler({});
    }
  }
}

export const router = new Router();
