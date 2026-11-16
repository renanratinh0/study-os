/**
 * Study OS V2 - ImmersiveCinemaModal (Lazy Loaded via Dynamic Import)
 * Modo Playlist & Cinema Imersivo com Lupa 2.2x interativa (rastreamento 360° do mouse),
 * Idle Timer (2800ms) com ocultação suave de controles, players contínuos de Vídeo,
 * Áudio e Slides PDF, e governança estrita de recursos multimídia.
 */

import { store } from "../core/store.js";
import { escapeHtml, obterTituloAula } from "../utils/domHelpers.js";
import { resolverFontesMidia } from "../services/mediaResolver.js";
import { mostrarToast } from "../utils/domHelpers.js";

// Estado isolado da playlist imersiva
export const playlistState = {
  tipoAtivo: null,
  indiceAtivo: 0,
  itens: [],
  discAtual: null,
  isZoomed: false
};

let playlistIdleTimer = null;
let listenersIdleConfigurados = false;

/**
 * Reseta o timer de inatividade (2800ms) que oculta controles no modo cinema.
 */
export function resetarIdleTimerPlaylist() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("playlist-immersive-modal");
  if (!modal || modal.classList.contains("hidden")) return;

  modal.classList.remove("immersive-idle");
  clearTimeout(playlistIdleTimer);
  playlistIdleTimer = setTimeout(() => {
    const choiceModal = document.getElementById("playlist-choice-modal");
    if (choiceModal && !choiceModal.classList.contains("hidden")) return;
    modal.classList.add("immersive-idle");
  }, 2800);
}

/**
 * Configura os ouvintes de movimento e toque para resetar o idle timer.
 */
export function configurarListenersIdlePlaylist() {
  if (listenersIdleConfigurados || typeof document === "undefined") return;
  const modal = document.getElementById("playlist-immersive-modal");
  if (!modal) return;

  ["mousemove", "mousedown", "touchstart", "touchmove", "wheel"].forEach(evt => {
    modal.addEventListener(evt, () => resetarIdleTimerPlaylist(), { passive: true });
  });
  listenersIdleConfigurados = true;
}

/**
 * Alterna a ativação da Lupa de Zoom 2.2x sobre a imagem ativa.
 */
export function toggleZoomImagemPlaylist(e) {
  if (typeof document === "undefined") return;
  const img = document.getElementById("playlist-active-image");
  const indicator = document.getElementById("playlist-zoom-indicator");
  const zoomBtn = document.getElementById("immersive-zoom-btn");
  if (!img) return;

  playlistState.isZoomed = !playlistState.isZoomed;

  if (playlistState.isZoomed) {
    const viewport = document.getElementById("playlist-img-viewport");
    const vRect = viewport ? viewport.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const imgW = img.offsetWidth || 800;
    const imgH = img.offsetHeight || 600;
    const imgCenterX = vRect.left + vRect.width / 2;
    const imgCenterY = vRect.top + vRect.height / 2;
    const imgLeft = imgCenterX - imgW / 2;
    const imgTop = imgCenterY - imgH / 2;

    const clientX = e && typeof e.clientX === "number" ? e.clientX : imgCenterX;
    const clientY = e && typeof e.clientY === "number" ? e.clientY : imgCenterY;

    const xPercent = Math.max(0, Math.min(100, ((clientX - imgLeft) / imgW) * 100));
    const yPercent = Math.max(0, Math.min(100, ((clientY - imgTop) / imgH) * 100));

    img.style.transformOrigin = `${xPercent.toFixed(2)}% ${yPercent.toFixed(2)}%`;
    img.style.transform = "scale(2.2)";
    img.classList.remove("cursor-pointer");
    img.classList.add("cursor-zoom-out");
    if (indicator) indicator.classList.remove("hidden");
    if (zoomBtn) {
      zoomBtn.classList.add("bg-emerald-600/40", "border-emerald-500/60", "text-emerald-300");
      zoomBtn.innerHTML = `<span>🔍</span><span class="font-bold">2.2x Ativo</span>`;
    }
  } else {
    img.style.transform = "scale(1)";
    img.style.transformOrigin = "center center";
    img.classList.remove("cursor-zoom-out");
    img.classList.add("cursor-pointer");
    if (indicator) indicator.classList.add("hidden");
    if (zoomBtn) {
      zoomBtn.classList.remove("bg-emerald-600/40", "border-emerald-500/60", "text-emerald-300");
      zoomBtn.innerHTML = `<span>🔍</span><span>Zoom 2.2x</span>`;
    }
  }
}

/**
 * Movimentação omnidirecional suave da lupa de zoom acompanhando o cursor do mouse.
 */
export function handleMouseMoveZoomPlaylist(e) {
  if (!playlistState.isZoomed || typeof document === "undefined") return;
  const img = document.getElementById("playlist-active-image");
  const viewport = document.getElementById("playlist-img-viewport");
  if (!img || !viewport) return;

  const vRect = viewport.getBoundingClientRect();
  if (!vRect.width || !vRect.height) return;

  const imgW = img.offsetWidth;
  const imgH = img.offsetHeight;
  if (!imgW || !imgH) return;

  const imgCenterX = vRect.left + vRect.width / 2;
  const imgCenterY = vRect.top + vRect.height / 2;
  const imgLeft = imgCenterX - imgW / 2;
  const imgTop = imgCenterY - imgH / 2;

  const xPercent = Math.max(0, Math.min(100, ((e.clientX - imgLeft) / imgW) * 100));
  const yPercent = Math.max(0, Math.min(100, ((e.clientY - imgTop) / imgH) * 100));

  img.style.transformOrigin = `${xPercent.toFixed(2)}% ${yPercent.toFixed(2)}%`;
}

/**
 * Clique na imagem: se no zoom desativa; se normal avança instantaneamente.
 */
export function handleImagemPlaylistClick(e) {
  if (playlistState.isZoomed) {
    toggleZoomImagemPlaylist(e);
  } else {
    avancarPlaylist();
  }
}

/**
 * Varre a disciplina para extrair itens multimídia compatíveis com o tipo de playlist.
 */
export function coletarItensPlaylist(disc, tipo) {
  if (!disc || !Array.isArray(disc.aulas)) return [];
  const resultado = [];

  disc.aulas.forEach(aula => {
    const arquivos = aula.arquivos || [];
    arquivos.forEach(arq => {
      const ext = String(arq.tipo || (arq.nome || "").split(".").pop() || "").toLowerCase();
      const fontes = resolverFontesMidia(arq, aula.id);

      if (tipo === "video") {
        if (["mp4", "mov", "webm"].includes(ext) || arq.mimeType?.includes("video")) {
          resultado.push({
            aulaId: aula.id,
            aulaNome: aula.nome,
            aulaTitulo: obterTituloAula(aula),
            arq,
            nome: arq.nome,
            fontes
          });
        }
      } else if (tipo === "img") {
        if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext) || arq.mimeType?.includes("image")) {
          const src = fontes.blobUrl || fontes.urlDriveImage || fontes.urlDriveThumb || fontes.urlLocalConfigurado || fontes.urlLocalDireto;
          resultado.push({
            aulaId: aula.id,
            aulaNome: aula.nome,
            aulaTitulo: obterTituloAula(aula),
            arq,
            nome: arq.nome,
            src,
            fontes
          });
        }
      } else if (tipo === "pdf") {
        if (ext === "pdf" && (arq.temOCR === false || arq.statusOCR === "sem_ocr")) {
          const src = fontes.blobUrl || fontes.urlDrivePreview || fontes.urlLocalConfigurado || fontes.urlLocalDireto;
          const link = fontes.urlDriveView || fontes.blobUrl || fontes.urlLocalConfigurado;
          resultado.push({
            aulaId: aula.id,
            aulaNome: aula.nome,
            aulaTitulo: obterTituloAula(aula),
            arq,
            nome: arq.nome,
            src,
            link,
            fontes
          });
        }
      } else if (tipo === "audio") {
        if (["m4a", "mp3", "wav", "aac"].includes(ext) || arq.mimeType?.includes("audio")) {
          resultado.push({
            aulaId: aula.id,
            aulaNome: aula.nome,
            aulaTitulo: obterTituloAula(aula),
            arq,
            nome: arq.nome,
            fontes
          });
        }
      }
    });
  });

  return resultado;
}

/**
 * Renderiza os pills de alternância rápida de mídia na topbar do modo cinema.
 */
export function renderizarTopbarPillsPlaylist() {
  if (typeof document === "undefined") return;
  const bar = document.getElementById("immersive-quick-pills");
  const disc = playlistState.discAtual;
  if (!bar || !disc) return;

  const vids = coletarItensPlaylist(disc, "video");
  const imgs = coletarItensPlaylist(disc, "img");
  const pdfs = coletarItensPlaylist(disc, "pdf");
  const audios = coletarItensPlaylist(disc, "audio");

  const opcoes = [
    { tipo: "video", icone: "🎬", nome: "Vídeos", count: vids.length },
    { tipo: "img", icone: "🖼️", nome: "Fotos", count: imgs.length },
    { tipo: "pdf", icone: "📄", nome: "PDFs", count: pdfs.length },
    { tipo: "audio", icone: "🎧", nome: "Áudios", count: audios.length }
  ];

  bar.innerHTML = opcoes.map(op => {
    const ativo = playlistState.tipoAtivo === op.tipo;
    const desab = op.count === 0;
    return `
      <button onclick="${desab ? '' : `window.StudyOS?.iniciarPlaylistModo('${op.tipo}')`}"
        ${desab ? 'disabled' : ''}
        title="${op.nome} (${op.count})"
        class="px-2 py-1 rounded-lg text-xs font-mono transition-all flex items-center gap-1 cursor-pointer ${
          ativo
            ? 'bg-indigo-600 text-white font-bold shadow-sm'
            : desab
            ? 'opacity-30 cursor-not-allowed text-notion-muted'
            : 'text-notion-muted hover:text-white hover:bg-white/10'
        }">
        <span>${op.icone}</span>
        <span class="hidden lg:inline">${op.nome}</span>
        <span class="text-[10px] opacity-75">(${op.count})</span>
      </button>
    `;
  }).join("");
}

/**
 * Abre o modal de escolha do tipo de mídia para a playlist.
 * @param {object} disc
 */
export function abrirModalEscolhaPlaylist(disc) {
  if (typeof document === "undefined") return;
  if (!disc) {
    mostrarToast("Atenção", "Abra uma matéria antes de iniciar a Playlist.", "info");
    return;
  }

  const vids = coletarItensPlaylist(disc, "video");
  const imgs = coletarItensPlaylist(disc, "img");
  const pdfs = coletarItensPlaylist(disc, "pdf");
  const audios = coletarItensPlaylist(disc, "audio");

  const titleEl = document.getElementById("playlist-choice-title");
  if (titleEl) titleEl.textContent = `Modo Cinema & Playlist — ${disc.nome}`;

  document.getElementById("playlist-count-video")?.replaceChildren(document.createTextNode(`${vids.length} vídeo(s)`));
  document.getElementById("playlist-count-img")?.replaceChildren(document.createTextNode(`${imgs.length} imagem(ns)`));
  document.getElementById("playlist-count-pdf")?.replaceChildren(document.createTextNode(`${pdfs.length} slide(s)/PDF(s)`));
  document.getElementById("playlist-count-audio")?.replaceChildren(document.createTextNode(`${audios.length} áudio(s)`));

  const cardVid = document.getElementById("card-choice-video");
  if (cardVid) cardVid.style.opacity = vids.length ? "1" : "0.4";
  const cardImg = document.getElementById("card-choice-img");
  if (cardImg) cardImg.style.opacity = imgs.length ? "1" : "0.4";
  const cardPdf = document.getElementById("card-choice-pdf");
  if (cardPdf) cardPdf.style.opacity = pdfs.length ? "1" : "0.4";
  const cardAud = document.getElementById("card-choice-audio");
  if (cardAud) cardAud.style.opacity = audios.length ? "1" : "0.4";

  const modal = document.getElementById("playlist-choice-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

/**
 * Fecha o modal de escolha da playlist.
 */
export function fecharModalEscolhaPlaylist() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("playlist-choice-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

/**
 * Inicia o Modo Cinema com o tipo de mídia selecionado.
 */
export function iniciarPlaylistModo(disc, tipo) {
  if (!disc) return;

  const itens = coletarItensPlaylist(disc, tipo);
  if (itens.length === 0) {
    mostrarToast("Sem Mídias", `Não foram encontrados conteúdos de ${tipo} nesta disciplina.`, "info");
    return;
  }

  fecharModalEscolhaPlaylist();

  playlistState.tipoAtivo = tipo;
  playlistState.indiceAtivo = 0;
  playlistState.itens = itens;
  playlistState.discAtual = disc;
  playlistState.isZoomed = false;

  const modalImersivo = document.getElementById("playlist-immersive-modal");
  if (modalImersivo) {
    modalImersivo.classList.remove("hidden");
    modalImersivo.classList.add("flex");
    modalImersivo.classList.remove("immersive-idle");
  }

  configurarListenersIdlePlaylist();
  resetarIdleTimerPlaylist();
  renderizarTopbarPillsPlaylist();
  renderizarConteudoPlaylist();
}

/**
 * Fecha o Modo Cinema, desliga players de mídia e limpa timers.
 */
export function fecharPlaylistImersiva() {
  clearTimeout(playlistIdleTimer);
  const modalImersivo = document.getElementById("playlist-immersive-modal");
  if (modalImersivo) {
    modalImersivo.classList.add("hidden");
    modalImersivo.classList.remove("flex");
    modalImersivo.classList.remove("immersive-idle");
  }

  playlistState.isZoomed = false;

  const vid = document.getElementById("playlist-video-player");
  if (vid) {
    try { vid.pause(); } catch (_) {}
  }
  const aud = document.getElementById("playlist-audio-player");
  if (aud) {
    try { aud.pause(); } catch (_) {}
  }

  if (typeof document !== "undefined" && document.fullscreenElement) {
    try { document.exitFullscreen(); } catch (_) {}
  }
}

/**
 * Alterna tela cheia nativa do navegador.
 */
export function alternarTelaCheiaPlaylist() {
  if (typeof document === "undefined") return;
  const el = document.getElementById("playlist-immersive-modal");
  if (!el) return;
  if (!document.fullscreenElement) {
    el.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
}

/**
 * Avança para o próximo item da playlist.
 */
export function avancarPlaylist() {
  if (!playlistState.itens.length) return;
  playlistState.isZoomed = false;
  resetarIdleTimerPlaylist();

  if (playlistState.tipoAtivo === "img") {
    playlistState.indiceAtivo = (playlistState.indiceAtivo + 1) % playlistState.itens.length;
  } else {
    if (playlistState.indiceAtivo < playlistState.itens.length - 1) {
      playlistState.indiceAtivo++;
    }
  }
  renderizarConteudoPlaylist();
}

/**
 * Retrocede para o item anterior da playlist.
 */
export function retrocederPlaylist() {
  if (!playlistState.itens.length) return;
  playlistState.isZoomed = false;
  resetarIdleTimerPlaylist();

  if (playlistState.tipoAtivo === "img") {
    playlistState.indiceAtivo = (playlistState.indiceAtivo - 1 + playlistState.itens.length) % playlistState.itens.length;
  } else {
    if (playlistState.indiceAtivo > 0) {
      playlistState.indiceAtivo--;
    }
  }
  renderizarConteudoPlaylist();
}

/**
 * Salta diretamente para um índice da playlist.
 */
export function pularParaItemPlaylist(indice) {
  if (indice >= 0 && indice < playlistState.itens.length) {
    playlistState.isZoomed = false;
    playlistState.indiceAtivo = indice;
    resetarIdleTimerPlaylist();
    renderizarConteudoPlaylist();
  }
}

/**
 * Renderiza o corpo do modal cinema conforme o tipo ativo (imagem, vídeo, áudio, pdf).
 */
export function renderizarConteudoPlaylist() {
  if (typeof document === "undefined") return;
  const { tipoAtivo, indiceAtivo, itens, discAtual } = playlistState;
  const container = document.getElementById("immersive-body-container");
  const badgeTipo = document.getElementById("immersive-mode-badge");
  const discTituloEl = document.getElementById("immersive-disc-title");
  const itemSubEl = document.getElementById("immersive-item-subtitle");
  const counterEl = document.getElementById("immersive-counter-badge");
  const zoomBtn = document.getElementById("immersive-zoom-btn");

  if (!container || !discAtual || !itens.length) return;

  renderizarTopbarPillsPlaylist();

  const itemAtual = itens[indiceAtivo] || itens[0];
  if (discTituloEl) discTituloEl.textContent = discAtual.nome;

  if (zoomBtn) {
    zoomBtn.classList.toggle("hidden", tipoAtivo !== "img");
    zoomBtn.classList.toggle("inline-flex", tipoAtivo === "img");
    if (playlistState.isZoomed) {
      zoomBtn.classList.add("bg-emerald-600/40", "border-emerald-500/60", "text-emerald-300");
      zoomBtn.innerHTML = `<span>🔍</span><span class="font-bold">2.2x Ativo</span>`;
    } else {
      zoomBtn.classList.remove("bg-emerald-600/40", "border-emerald-500/60", "text-emerald-300");
      zoomBtn.innerHTML = `<span>🔍</span><span>Zoom 2.2x</span>`;
    }
  }

  if (tipoAtivo === "img") {
    if (badgeTipo) {
      badgeTipo.textContent = "🖼️ Galeria de Imagens";
      badgeTipo.className = "px-2.5 py-1 rounded-lg bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-mono text-xs font-bold uppercase shrink-0";
    }
    if (itemSubEl) itemSubEl.textContent = `${itemAtual.aulaNome}: ${itemAtual.aulaTitulo}`;
    if (counterEl) counterEl.textContent = `${indiceAtivo + 1} / ${itens.length}`;

    container.className = "flex-1 min-h-0 overflow-hidden flex flex-col items-center justify-between p-2 sm:p-4 relative bg-black/75 select-none";
    container.innerHTML = `
      <div id="playlist-img-viewport"
        onmousemove="window.StudyOS?.handleMouseMoveZoomPlaylist(event)"
        class="flex-1 w-full flex items-center justify-center relative min-h-0 overflow-hidden">
        <img id="playlist-active-image"
          src="${escapeHtml(itemAtual.src)}"
          alt="${escapeHtml(itemAtual.nome)}"
          onclick="window.StudyOS?.handleImagemPlaylistClick(event)"
          title="1 clique avança a foto • Botão Zoom 2.2x ativa a lupa"
          class="max-h-[68vh] sm:max-h-[74vh] max-w-[95%] object-contain rounded-xl shadow-2xl cursor-pointer select-none border border-white/10"
        />

        <div id="playlist-zoom-indicator" class="hidden absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/85 backdrop-blur-md border border-emerald-500/50 text-xs font-mono text-emerald-300 shadow-2xl pointer-events-none z-30 flex items-center gap-2">
          <span>🔍 Lupa 2.2x Ativa</span>
          <span class="text-white/70">• Mova o mouse em qualquer direção</span>
          <span class="text-white/40 hidden sm:inline">• Clique para desativar</span>
        </div>

        <button onclick="window.StudyOS?.retrocederPlaylist()" title="Foto Anterior (⬅)"
          class="immersive-side-arrow absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-14 sm:h-14 rounded-full bg-black/50 hover:bg-indigo-600/90 text-white backdrop-blur-md border border-white/20 flex items-center justify-center text-xl shadow-2xl transition-all cursor-pointer z-20 hover:scale-110 active:scale-95">
          ◀
        </button>
        <button onclick="window.StudyOS?.avancarPlaylist()" title="Próxima Foto (➔)"
          class="immersive-side-arrow absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-14 sm:h-14 rounded-full bg-black/50 hover:bg-indigo-600/90 text-white backdrop-blur-md border border-white/20 flex items-center justify-center text-xl shadow-2xl transition-all cursor-pointer z-20 hover:scale-110 active:scale-95">
          ▶
        </button>
      </div>

      <div id="immersive-bottom-bar" class="w-full max-w-4xl bg-black/60 backdrop-blur-md border border-white/10 rounded-2xl p-2.5 mx-auto space-y-2 shrink-0 immersive-control-fade-bottom z-20">
        <div class="text-center space-y-0.5">
          <div class="text-xs font-semibold text-white flex items-center justify-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px] font-bold">${escapeHtml(itemAtual.aulaNome)}</span>
            <span class="truncate max-w-md">${escapeHtml(itemAtual.aulaTitulo)}</span>
            <span class="text-notion-muted font-mono text-[11px] truncate">(${escapeHtml(itemAtual.nome)})</span>
          </div>
          <div class="text-[11px] text-notion-muted flex items-center justify-center gap-2 flex-wrap">
            <span class="text-emerald-300 font-medium">💡 1 clique avança a foto</span>
            <span>&bull;</span>
            <span class="text-emerald-300 font-medium">Botão 🔍 Zoom 2.2x ativa a Lupa</span>
            <span>&bull;</span>
            <span>Use as setas ◀ ▶ do teclado</span>
          </div>
        </div>

        <div class="w-full overflow-x-auto py-1 flex items-center gap-2 justify-start sm:justify-center">
          ${itens.map((it, idx) => `
            <button onclick="window.StudyOS?.pularParaItemPlaylist(${idx})" title="${escapeHtml(it.aulaNome)}: ${escapeHtml(it.nome)}"
              class="w-12 h-9 sm:w-14 sm:h-10 rounded-lg overflow-hidden border-2 shrink-0 transition-all cursor-pointer ${idx === indiceAtivo ? 'border-emerald-400 scale-105 shadow-md brightness-110' : 'border-zinc-800 opacity-50 hover:opacity-100'}">
              <img src="${escapeHtml(it.src)}" class="w-full h-full object-cover" loading="lazy" />
            </button>
          `).join("")}
        </div>
      </div>
    `;
  } else if (tipoAtivo === "video") {
    if (badgeTipo) {
      badgeTipo.textContent = "🎬 Playlist de Vídeos";
      badgeTipo.className = "px-2.5 py-1 rounded-lg bg-purple-600/30 border border-purple-500/40 text-purple-300 font-mono text-xs font-bold uppercase shrink-0";
    }
    if (itemSubEl) itemSubEl.textContent = `${itemAtual.aulaNome}: ${itemAtual.aulaTitulo}`;
    if (counterEl) counterEl.textContent = `${indiceAtivo + 1} / ${itens.length}`;

    const f = itemAtual.fontes;
    const usarVideoTag = Boolean(f.blobUrl || (!f.driveIdValido && f.urlLocalConfigurado));
    const srcVideo = f.blobUrl || f.urlLocalConfigurado;

    container.className = "flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-between p-3 sm:p-5 space-y-4 bg-black/75 relative";
    container.innerHTML = `
      <div class="w-full max-w-5xl aspect-video bg-black rounded-2xl overflow-hidden border border-white/10 shadow-2xl relative flex items-center justify-center">
        ${usarVideoTag ? `
          <video id="playlist-video-player" controls autoplay class="w-full h-full object-contain">
            <source src="${escapeHtml(srcVideo)}" type="video/mp4" />
            <source src="${escapeHtml(f.urlLocalDireto)}" type="video/mp4" />
          </video>
        ` : f.urlDrivePreview ? `
          <iframe src="${escapeHtml(f.urlDrivePreview)}" class="w-full h-full border-0" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>
        ` : `
          <div class="p-8 text-center text-xs text-notion-muted">
            🎬 Vídeo aguardando conexão local ou link público no Google Drive.
          </div>
        `}

        <button onclick="window.StudyOS?.retrocederPlaylist()" ${indiceAtivo === 0 ? "disabled" : ""} title="Vídeo Anterior (⬅)"
          class="immersive-side-arrow absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 hover:bg-purple-600 text-white backdrop-blur-md border border-white/20 disabled:opacity-0 disabled:pointer-events-none flex items-center justify-center text-lg shadow-2xl transition-all cursor-pointer z-20">
          ◀
        </button>
        <button onclick="window.StudyOS?.avancarPlaylist()" ${indiceAtivo === itens.length - 1 ? "disabled" : ""} title="Próximo Vídeo (➔)"
          class="immersive-side-arrow absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 hover:bg-purple-600 text-white backdrop-blur-md border border-white/20 disabled:opacity-0 disabled:pointer-events-none flex items-center justify-center text-lg shadow-2xl transition-all cursor-pointer z-20">
          ▶
        </button>
      </div>

      <div id="immersive-bottom-bar" class="w-full max-w-5xl bg-black/60 backdrop-blur-md p-3 rounded-2xl border border-white/10 flex flex-col gap-2 shrink-0 immersive-control-fade-bottom z-20">
        <div class="flex items-center justify-between gap-3">
          <button onclick="window.StudyOS?.retrocederPlaylist()" ${indiceAtivo === 0 ? "disabled" : ""}
            class="px-4 py-2 rounded-lg bg-black/50 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none text-xs font-semibold text-white border border-white/10 transition-colors flex items-center gap-2 cursor-pointer">
            <span>⏮️</span>
            <span class="hidden sm:inline">Vídeo Anterior</span>
          </button>

          <div class="text-center min-w-0 truncate px-2">
            <div class="font-bold text-white text-xs sm:text-sm truncate">[${itemAtual.aulaNome}] ${escapeHtml(itemAtual.aulaTitulo)}</div>
            <div class="text-[11px] text-notion-muted font-mono truncate">${escapeHtml(itemAtual.nome)}</div>
          </div>

          <button onclick="window.StudyOS?.avancarPlaylist()" ${indiceAtivo === itens.length - 1 ? "disabled" : ""}
            class="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-30 disabled:pointer-events-none text-xs font-semibold text-white shadow-md transition-colors flex items-center gap-2 cursor-pointer">
            <span class="hidden sm:inline">Próximo Vídeo</span>
            <span>⏭️</span>
          </button>
        </div>

        <div class="w-full overflow-x-auto pb-1 flex items-center gap-2">
          ${itens.map((v, i) => `
            <button onclick="window.StudyOS?.pularParaItemPlaylist(${i})"
              class="px-3 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap transition-all border shrink-0 cursor-pointer ${i === indiceAtivo ? 'bg-purple-600 text-white border-purple-400 font-bold shadow-sm' : 'bg-black/40 text-notion-muted hover:text-white border-white/10'}">
              🎬 ${escapeHtml(v.aulaNome)}
            </button>
          `).join("")}
        </div>
      </div>
    `;

    const vidEl = document.getElementById("playlist-video-player");
    if (vidEl) {
      vidEl.onended = () => {
        if (playlistState.indiceAtivo < playlistState.itens.length - 1) {
          avancarPlaylist();
        }
      };
    }
  } else if (tipoAtivo === "pdf") {
    if (badgeTipo) {
      badgeTipo.textContent = "📄 Apresentações em Slides";
      badgeTipo.className = "px-2.5 py-1 rounded-lg bg-rose-600/30 border border-rose-500/40 text-rose-300 font-mono text-xs font-bold uppercase shrink-0";
    }
    if (itemSubEl) itemSubEl.textContent = `${itens.length} Apresentações já carregadas sequencialmente`;
    if (counterEl) counterEl.textContent = `${itens.length} slides`;

    container.className = "flex-1 min-h-0 overflow-y-auto flex flex-col p-4 sm:p-6 lg:p-8 space-y-8 bg-black/75";
    container.innerHTML = `
      <div class="sticky top-0 z-30 -mt-2 py-2.5 px-4 bg-black/75 backdrop-blur-md rounded-xl border border-white/10 flex items-center gap-2 overflow-x-auto shadow-lg shrink-0">
        <span class="text-[11px] font-mono text-notion-muted uppercase tracking-wider shrink-0 mr-1">Ir para aula:</span>
        ${itens.map((p, idx) => `
          <button onclick="document.getElementById('pdf-stream-${idx}')?.scrollIntoView({ behavior: 'smooth', block: 'start' })"
            class="px-2.5 py-1 rounded-lg bg-black/50 hover:bg-rose-600 hover:text-white border border-white/10 text-xs font-mono text-notion-text transition-all shrink-0 cursor-pointer">
            📄 ${escapeHtml(p.aulaNome)}
          </button>
        `).join("")}
      </div>

      <div class="w-full max-w-4xl mx-auto space-y-8">
        ${itens.map((p, idx) => `
          <div id="pdf-stream-${idx}" class="space-y-2 rounded-2xl bg-notion-bg/90 border border-notion-border p-3 sm:p-4 shadow-xl">
            <div class="flex items-center justify-between gap-3 px-2 py-1 flex-wrap">
              <div class="flex items-center gap-2 min-w-0">
                <span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono font-bold text-[10px] shrink-0">${escapeHtml(p.aulaNome)}</span>
                <span class="text-xs font-bold text-white truncate">${escapeHtml(p.aulaTitulo)}</span>
                <span class="text-[11px] font-mono text-notion-muted truncate">(${escapeHtml(p.nome)})</span>
              </div>
              ${p.link ? `
                <a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer"
                  class="text-[11px] font-mono text-indigo-400 hover:text-indigo-300 transition-colors">
                  Abrir em Nova Guia ↗
                </a>
              ` : ""}
            </div>

            <div class="w-full max-w-[940px] mx-auto h-[450px] sm:h-[490px] bg-zinc-900 overflow-hidden relative rounded-xl border border-zinc-800">
              <iframe src="${escapeHtml(p.src)}" class="w-full h-full border-0 bg-zinc-900" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  } else if (tipoAtivo === "audio") {
    if (badgeTipo) {
      badgeTipo.textContent = "🎧 Playlist de Áudios";
      badgeTipo.className = "px-2.5 py-1 rounded-lg bg-pink-600/30 border border-pink-500/40 text-pink-300 font-mono text-xs font-bold uppercase shrink-0";
    }
    if (itemSubEl) itemSubEl.textContent = `${itemAtual.aulaNome}: ${itemAtual.aulaTitulo}`;
    if (counterEl) counterEl.textContent = `${indiceAtivo + 1} / ${itens.length}`;

    const f = itemAtual.fontes;

    container.className = "flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center p-4 sm:p-6 space-y-6 bg-black/75 relative";
    container.innerHTML = `
      <button onclick="window.StudyOS?.retrocederPlaylist()" ${indiceAtivo === 0 ? "disabled" : ""} title="Áudio Anterior (⬅)"
        class="immersive-side-arrow absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-14 sm:h-14 rounded-full bg-black/50 hover:bg-pink-600 text-white backdrop-blur-md border border-white/20 disabled:opacity-0 disabled:pointer-events-none flex items-center justify-center text-xl shadow-2xl transition-all cursor-pointer z-20">
        ◀
      </button>
      <button onclick="window.StudyOS?.avancarPlaylist()" ${indiceAtivo === itens.length - 1 ? "disabled" : ""} title="Próximo Áudio (➔)"
        class="immersive-side-arrow absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-14 sm:h-14 rounded-full bg-black/50 hover:bg-pink-600 text-white backdrop-blur-md border border-white/20 disabled:opacity-0 disabled:pointer-events-none flex items-center justify-center text-xl shadow-2xl transition-all cursor-pointer z-20">
        ▶
      </button>

      <div class="w-full max-w-xl bg-black/60 backdrop-blur-xl border border-pink-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl text-center space-y-6 relative z-10">
        <div class="w-20 h-20 rounded-2xl bg-pink-500/20 border border-pink-500/40 text-4xl flex items-center justify-center mx-auto shadow-lg shadow-pink-500/10">
          🎧
        </div>

        <div>
          <div class="font-mono text-xs text-pink-400 uppercase tracking-widest">${escapeHtml(itemAtual.aulaNome)}</div>
          <h3 class="text-lg sm:text-xl font-bold text-white mt-1">${escapeHtml(itemAtual.aulaTitulo)}</h3>
          <p class="text-xs text-notion-muted font-mono mt-1">${escapeHtml(itemAtual.nome)}</p>
        </div>

        <div class="w-full">
          ${f.blobUrl ? `
            <audio id="playlist-audio-player" controls autoplay class="w-full">
              <source src="${escapeHtml(f.blobUrl)}" />
            </audio>
          ` : f.urlDrivePreview ? `
            <div class="w-full h-24 rounded-2xl overflow-hidden border border-pink-500/40 bg-black shadow-xl">
              <iframe src="${escapeHtml(f.urlDrivePreview)}" class="w-full h-full border-0" allow="autoplay" loading="lazy"></iframe>
            </div>
          ` : `
            <div class="text-xs text-notion-muted p-4 bg-black/40 rounded-xl border border-white/10">
              Áudio aguardando ID do Google Drive ou sincronização local.
            </div>
          `}
        </div>

        <div class="flex items-center justify-between gap-3 pt-2">
          <button onclick="window.StudyOS?.retrocederPlaylist()" ${indiceAtivo === 0 ? "disabled" : ""}
            class="px-4 py-2 rounded-xl bg-black/40 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none text-xs font-semibold text-white border border-white/10 transition-colors cursor-pointer flex items-center gap-1.5">
            <span>⏮️</span>
            <span>Anterior</span>
          </button>
          <span class="text-xs font-mono text-notion-muted">${indiceAtivo + 1} de ${itens.length}</span>
          <button onclick="window.StudyOS?.avancarPlaylist()" ${indiceAtivo === itens.length - 1 ? "disabled" : ""}
            class="px-4 py-2 rounded-xl bg-pink-600 hover:bg-pink-500 disabled:opacity-30 disabled:pointer-events-none text-xs font-semibold text-white shadow-md transition-colors cursor-pointer flex items-center gap-1.5">
            <span>Próximo</span>
            <span>⏭️</span>
          </button>
        </div>
      </div>

      <div class="w-full max-w-2xl overflow-x-auto pb-1 flex items-center gap-2 shrink-0 z-10">
        ${itens.map((a, i) => `
          <button onclick="window.StudyOS?.pularParaItemPlaylist(${i})"
            class="px-3 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap transition-all border shrink-0 cursor-pointer ${i === indiceAtivo ? 'bg-pink-600 text-white border-pink-400 font-bold shadow-sm' : 'bg-black/50 text-notion-muted hover:text-white border-white/10'}">
            🎧 ${escapeHtml(a.aulaNome)}
          </button>
        `).join("")}
      </div>
    `;

    const audEl = document.getElementById("playlist-audio-player");
    if (audEl) {
      audEl.onended = () => {
        if (playlistState.indiceAtivo < playlistState.itens.length - 1) {
          avancarPlaylist();
        }
      };
    }
  }
}
