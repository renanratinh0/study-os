/**
 * Study OS V2 - Performance & Lazy Loading
 * Gerenciamento centralizado de IntersectionObserver para carregamento tardio
 * de mídias pesadas (iframes, imagens e vídeos) com prevenção ativa de memory leaks.
 */

let mediaObserverInstance = null;

/**
 * Inicializa ou retorna a instância singleton do IntersectionObserver.
 * @param {IntersectionObserverInit} [options={ rootMargin: "250px 0px" }]
 * @returns {IntersectionObserver | null}
 */
export function iniciarMediaObserver(options = { rootMargin: "250px 0px" }) {
  if (mediaObserverInstance) return mediaObserverInstance;

  if (typeof IntersectionObserver !== "undefined") {
    mediaObserverInstance = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const dataSrc = el.getAttribute("data-src");
          if (dataSrc) {
            el.src = dataSrc;
            el.removeAttribute("data-src");
          }
          observer.unobserve(el);
        }
      });
    }, options);
  }

  return mediaObserverInstance;
}

/**
 * Conecta todos os elementos com atributo [data-src] do container ao observer.
 * Caso o navegador não suporte IntersectionObserver, carrega as mídias imediatamente.
 * @param {HTMLElement} container
 */
export function observarMidiasLazy(container) {
  if (!container || typeof container.querySelectorAll !== "function") return;

  const obs = iniciarMediaObserver();
  const elementos = container.querySelectorAll("[data-src]");

  if (obs) {
    elementos.forEach(el => obs.observe(el));
  } else {
    elementos.forEach(el => {
      const dataSrc = el.getAttribute("data-src");
      if (dataSrc) {
        el.src = dataSrc;
        el.removeAttribute("data-src");
      }
    });
  }
}

/**
 * Desconecta o observer e limpa a referência para evitar vazamentos de memória.
 */
export function desconectarMediaObserver() {
  if (mediaObserverInstance) {
    try {
      mediaObserverInstance.disconnect();
    } catch (_) {}
    mediaObserverInstance = null;
  }
}
