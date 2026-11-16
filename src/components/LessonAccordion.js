/**
 * Study OS V2 - LessonAccordion Component
 * Acordeão de H1 Toggles contínuos das aulas, barra de filtros multisseleção das 6 mídias,
 * renderizador sob demanda de Markdown, Imagens Verticais 10:16/9:16, Infográficos PNG,
 * PDFs Sem OCR, Vídeos, Áudios e NotebookLM com alertas dinâmicos de mídias ausentes.
 */

import { store, calcularStatusAula, verificarLinkNotebookDuplicado } from "../core/store.js";
import { OPCOES_MIDIA_AULA } from "../core/constants.js";
import { escapeHtml, slugify, obterTituloAula } from "../utils/domHelpers.js";
import { limparMarkdownDaAula, obterHtmlMarkdownParseado } from "../utils/markdownParser.js";
import { resolverFontesMidia, revogarBlobsDaAula } from "../services/mediaResolver.js";
import { observarMidiasLazy } from "../utils/performance.js";
import { salvarEdicaoMdCache } from "../services/storage.js";
import { enviarFilaEdicaoMd } from "../services/api.js";
import { mostrarToast } from "../utils/domHelpers.js";
import { isAdminAutenticado } from "../services/auth.js";

/**
 * Cria aviso visual padronizado quando uma das mídias não estiver cadastrada na aula.
 * Ocultado automaticamente para visitantes para manter uma experiência limpa e profissional.
 */
export function criarAvisoFaltaItemHtml(icone, tituloFalta, descricaoFalta, classesCor) {
  if (!isAdminAutenticado()) {
    return "";
  }
  return `
    <div class="p-4 rounded-2xl border ${classesCor} flex items-center justify-between gap-3 shadow-sm">
      <div class="flex items-center gap-3 min-w-0">
        <span class="w-9 h-9 rounded-xl bg-black/30 border border-white/10 flex items-center justify-center text-lg shrink-0">
          ${icone}
        </span>
        <div class="min-w-0">
          <div class="text-xs sm:text-sm font-bold tracking-wide uppercase font-mono">
            ⚠️ ${escapeHtml(tituloFalta)}
          </div>
          <div class="text-[11px] opacity-85 truncate">
            ${escapeHtml(descricaoFalta)}
          </div>
        </div>
      </div>
      <span class="px-2.5 py-1 rounded-lg bg-black/30 border border-white/10 text-[10px] font-mono uppercase tracking-wider shrink-0">
        Ausente na Aula
      </span>
    </div>
  `;
}

/**
 * Monta a estrutura interna de uma aula aberta exibindo apenas as mídias selecionadas.
 */
export function montarConteudoInternoDaAula(disc, aula) {
  const state = store.getState();
  const arquivos = aula.arquivos || [];
  const exibirMd = state.midiasAtivasAula.has("md");
  const exibirImg = state.midiasAtivasAula.has("img");
  const exibirPdf = state.midiasAtivasAula.has("pdf");
  const exibirVideo = state.midiasAtivasAula.has("video");
  const exibirAudio = state.midiasAtivasAula.has("audio");
  const exibirNotebook = state.midiasAtivasAula.has("notebook");

  const mds = [];
  const imagensJpg = [];
  const imagensPng = [];
  const pdfsSemOcr = [];
  let pdfsComOcrOcultados = 0;
  const videos = [];
  const audios = [];

  arquivos.forEach(arq => {
    const nomeLower = String(arq.nome || "").trim().toLowerCase();
    const mimeLower = String(arq.mimeType || "").trim().toLowerCase();
    const ext = String(arq.tipo || (nomeLower.includes(".") ? nomeLower.split(".").pop() : "") || "").toLowerCase();

    if (ext === "md" || ext === "markdown" || nomeLower.endsWith(".md") || arq.conteudoTexto) {
      mds.push(arq);
    } else if (
      ext === "jpg" ||
      ext === "jpeg" ||
      /\.jpe?g$/i.test(nomeLower) ||
      mimeLower.includes("jpeg") ||
      mimeLower.includes("jpg")
    ) {
      imagensJpg.push(arq);
    } else if (
      ["png", "webp", "gif", "svg"].includes(ext) ||
      /\.(png|webp|gif|svg)$/i.test(nomeLower) ||
      mimeLower.includes("png")
    ) {
      imagensPng.push(arq);
    } else if (ext === "pdf" || nomeLower.endsWith(".pdf") || mimeLower.includes("pdf")) {
      if (arq.temOCR === false || arq.statusOCR === "sem_ocr") {
        pdfsSemOcr.push(arq);
      } else {
        pdfsComOcrOcultados++;
      }
    } else if (["mp4", "mov", "webm"].includes(ext) || /\.(mp4|mov|webm)$/i.test(nomeLower)) {
      videos.push(arq);
    } else if (["m4a", "mp3", "wav", "aac"].includes(ext) || /\.(m4a|mp3|wav|aac)$/i.test(nomeLower)) {
      audios.push(arq);
    }
  });

  // 1º PASSO: TEXTO MARKDOWN (.MD) OU AVISO "FALTA MD"
  const blocoMdHtml = !exibirMd
    ? ""
    : mds.length > 0
      ? mds.map((mdArq, idxMd) => {
        const htmlId = slugify(`${aula.id}-md-${idxMd}`);
        const arquivoCacheId = mdArq.id || mdArq.local;
        const textoCru = state.cacheMarkdownTexto[arquivoCacheId] ?? mdArq.conteudoTexto ?? "";
        const htmlRenderizado = obterHtmlMarkdownParseado(textoCru);
        const localEncoded = encodeURIComponent(mdArq.local || "");
        const cacheIdEncoded = encodeURIComponent(arquivoCacheId || "");
        const stAula = calcularStatusAula(aula);
        const ehAdmin = isAdminAutenticado();

        return `
          <div class="rounded-2xl bg-notion-bg/90 border border-notion-border p-4 sm:p-7 lg:p-10 shadow-inner relative group">
            <div class="flex flex-wrap items-center justify-between gap-2 pb-4 mb-6 border-b border-notion-border text-xs text-notion-muted font-mono">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="flex items-center gap-1.5 text-amber-300 font-semibold">
                  <span>📝 1. Resumo & Conteúdo da Aula</span>
                  <span class="text-notion-muted">(${escapeHtml(mdArq.nome)})</span>
                </span>
                ${aula.data_aula
                  ? ehAdmin
                    ? `<button type="button" onclick="window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}')" title="Clique para editar a data no Notion" class="px-2 py-0.5 rounded bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/35 text-[10px] flex items-center gap-1 cursor-pointer transition-colors"><span>📅 Data: ${escapeHtml(aula.data_aula)}</span> <span class="text-[9px] opacity-75">✏️</span></button>`
                    : `<span class="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/35 text-[10px] font-mono select-none" title="Data da Aula">📅 Data: ${escapeHtml(aula.data_aula)}</span>`
                  : ehAdmin
                    ? `<button type="button" onclick="window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}')" title="Definir data desta aula no Notion" class="px-2 py-0.5 rounded bg-notion-card hover:bg-cyan-500/20 text-notion-muted hover:text-cyan-300 border border-notion-border text-[10px] cursor-pointer transition-colors">📅 + Definir Data</button>`
                    : ""}
                ${stAula.presenca ? `<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">✅ Presente</span>` : stAula.falta ? `<span class="px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px] font-bold">🟥 Falta</span>` : ""}
                ${stAula.revisao ? `<span class="px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 text-[10px]">🆗 Revisada</span>` : ""}
              </div>
              ${ehAdmin ? `
                <button
                  type="button"
                  id="btn-edit-${htmlId}"
                  onclick="window.StudyOS?.iniciarEdicaoMd('${htmlId}')"
                  class="px-3 py-1.5 rounded-lg bg-notion-card hover:bg-indigo-600/30 border border-notion-border hover:border-indigo-500/50 text-notion-text hover:text-indigo-200 transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <span>✏️</span>
                  <span>Editar Texto</span>
                </button>
              ` : `
                <span class="px-2.5 py-1 rounded-lg bg-zinc-800/40 border border-zinc-700/40 text-zinc-400 text-[11px] font-mono select-none flex items-center gap-1" title="Modo Visitante: Somente Leitura">
                  <span>🔒</span> <span>Somente Leitura</span>
                </span>
              `}
            </div>

            <!-- MODO DE VISUALIZAÇÃO -->
            <div id="md-view-${htmlId}">
              <article class="prose prose-invert prose-indigo max-w-none prose-headings:tracking-tight prose-p:leading-relaxed prose-li:my-1">
                ${htmlRenderizado}
              </article>
            </div>

            <!-- MODO DE EDIÇÃO -->
            <div id="md-editor-container-${htmlId}" class="hidden space-y-4">
              <div class="flex items-center justify-between px-3.5 py-2.5 bg-indigo-950/30 border border-indigo-500/30 rounded-xl text-xs text-notion-muted">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-indigo-400">📝</span>
                  <span class="text-indigo-200 font-medium">Modo de Edição</span>
                  <span class="text-notion-muted">&bull;</span>
                  <span class="font-mono text-[11px] text-zinc-400 truncate max-w-sm">${escapeHtml(mdArq.local || mdArq.nome)}</span>
                </div>
                <span class="text-[11px] text-emerald-400 flex items-center gap-1.5 font-medium shrink-0">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Nuvem Conectada
                </span>
              </div>

              <textarea
                id="md-textarea-${htmlId}"
                class="w-full h-[520px] bg-notion-bg text-notion-text border border-indigo-500/40 rounded-xl p-5 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/60 leading-relaxed resize-y shadow-lg"
                placeholder="Digite o conteúdo Markdown da aula aqui..."
              >${escapeHtml(textoCru)}</textarea>

              <div class="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onclick="window.StudyOS?.cancelarEdicaoMd('${htmlId}')"
                  class="px-4 py-2 rounded-lg text-xs font-semibold text-notion-muted hover:text-white bg-notion-card hover:bg-notion-hover border border-notion-border transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  id="btn-save-${htmlId}"
                  onclick="window.StudyOS?.salvarEdicaoMd('${htmlId}', '${localEncoded}', '${cacheIdEncoded}', '${aula.id}')"
                  class="px-5 py-2.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg transition-all flex items-center gap-2 cursor-pointer"
                >
                  <span>💾 Salvar Alterações</span>
                </button>
              </div>
            </div>
          </div>
        `;
      }).join("")
      : criarAvisoFaltaItemHtml(
        "📝",
        "Falta MD",
        "Nenhum resumo em Markdown (.md) foi encontrado nesta aula.",
        "bg-amber-500/10 border-amber-500/40 text-amber-300"
      );

  // 2º PASSO (PARTE A): IMAGENS .JPG (FORMATO 9:16 / 10:16 CELULAR CROPADO) OU AVISO "FALTA JPG"
  const blocoJpgHtml = !exibirImg
    ? ""
    : imagensJpg.length > 0
      ? `
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-orange-400">
            <span>📱 2A. Resumo Visual Vertical (.JPG 9:16 • ${imagensJpg.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-6 items-start">
            ${imagensJpg.map((img, idxImg) => {
              const f = resolverFontesMidia(img, aula.id);
              const srcPrimario = f.blobUrl || f.urlDriveThumb || f.urlDriveImage || f.urlLocalConfigurado;
              const fallback1 = f.urlDriveImage || f.urlLocalConfigurado || f.urlLocalDireto;
              const fallback2 = f.urlLocalConfigurado || f.urlLocalDireto;
              const cropBoxId = `jpg-crop-box-${aula.id}-${idxImg}`;
              const cropImgId = `jpg-crop-img-${aula.id}-${idxImg}`;

              return `
                <figure class="rounded-2xl bg-notion-bg border border-notion-border overflow-hidden shadow-xl">
                  <div class="px-4 py-2.5 border-b border-notion-border flex flex-wrap items-center justify-between gap-2 text-xs bg-notion-sidebar/60">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="px-2 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30 font-mono text-[10px] shrink-0">📱 Vertical Crop (.JPG)</span>
                      <span class="font-mono text-notion-text truncate">🖼️ ${escapeHtml(img.nome)}</span>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <button type="button" onclick="window.StudyOS?.ajustarModoCropJpg('${cropBoxId}', '${cropImgId}', '10-16', this)" class="px-2 py-0.5 rounded bg-indigo-600 text-white font-mono text-[10px] transition-colors" title="Recorte calibrado que remove as bordas pretas sem cortar as laterais do infográfico">10:16 Ideal</button>
                      <button type="button" onclick="window.StudyOS?.ajustarModoCropJpg('${cropBoxId}', '${cropImgId}', '9-16', this)" class="px-2 py-0.5 rounded bg-notion-card hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border font-mono text-[10px] transition-colors" title="Formato 9:16 mais estreito">9:16</button>
                      <button type="button" onclick="window.StudyOS?.ajustarModoCropJpg('${cropBoxId}', '${cropImgId}', 'full', this)" class="px-2 py-0.5 rounded bg-notion-card hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border font-mono text-[10px] transition-colors" title="Mostrar imagem inteira sem corte">Sem Crop</button>
                      <button type="button" onclick="window.StudyOS?.alternarZoomJpg('${cropBoxId}')" class="px-2 py-0.5 rounded bg-notion-card hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border font-mono text-[10px] transition-colors" title="Aumentar/Diminuir tamanho na tela">🔍 +Tamanho</button>
                      ${f.urlDriveView ? `<a href="${f.urlDriveView}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:underline font-mono text-[11px] ml-1">Abrir no Drive ↗</a>` : ""}
                    </div>
                  </div>
                  <div class="p-3 sm:p-6 flex items-center justify-center bg-gradient-to-b from-black/60 via-zinc-950/80 to-black/60">
                    <div id="${cropBoxId}" data-zoom="normal" class="w-full max-w-[480px] sm:max-w-[560px] lg:max-w-[650px] aspect-[10/16] rounded-2xl overflow-hidden border border-white/15 shadow-2xl bg-zinc-950 relative transition-all duration-300">
                      <img
                        id="${cropImgId}"
                        src="${escapeHtml(srcPrimario)}"
                        alt="${escapeHtml(img.nome)}"
                        loading="lazy"
                        decoding="async"
                        onclick="window.StudyOS?.alternarZoomJpg('${cropBoxId}')"
                        title="Clique para ampliar/reduzir"
                        class="w-full h-full object-cover object-center scale-[1.035] cursor-zoom-in transition-transform duration-300"
                        onerror="if (this.dataset.tentativa !== '1' && '${escapeHtml(fallback1)}') { this.dataset.tentativa = '1'; this.src = '${escapeHtml(fallback1)}'; } else if (this.dataset.tentativa !== '2' && '${escapeHtml(fallback2)}') { this.dataset.tentativa = '2'; this.src = '${escapeHtml(fallback2)}'; }"
                      />
                    </div>
                  </div>
                </figure>
              `;
            }).join("")}
          </div>
        </div>
      `
      : criarAvisoFaltaItemHtml(
        "📱",
        "Falta JPG",
        "Nenhuma imagem vertical .jpg (formato 9:16 celular) foi encontrada nesta aula.",
        "bg-orange-500/10 border-orange-500/40 text-orange-300"
      );

  // 2º PASSO (PARTE B): IMAGENS .PNG (INFOGRÁFICO COMPLETO) OU AVISO "FALTA PNG"
  const blocoPngHtml = !exibirImg
    ? ""
    : imagensPng.length > 0
      ? `
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-400">
            <span>🖼️ 2B. Infográficos & Diagramas (.PNG • ${imagensPng.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-6 items-start">
            ${imagensPng.map(img => {
              const f = resolverFontesMidia(img, aula.id);
              const srcPrimario = f.blobUrl || f.urlDriveThumb || f.urlDriveImage || f.urlLocalConfigurado;
              const fallback1 = f.urlDriveImage || f.urlLocalConfigurado || f.urlLocalDireto;
              const fallback2 = f.urlLocalConfigurado || f.urlLocalDireto;

              return `
                <figure class="rounded-2xl bg-notion-bg border border-notion-border overflow-hidden shadow-lg">
                  <div class="px-4 py-2.5 border-b border-notion-border flex items-center justify-between text-xs bg-notion-sidebar/60">
                    <span class="font-mono text-notion-text truncate">🖼️ ${escapeHtml(img.nome)}</span>
                    ${f.urlDriveView ? `<a href="${f.urlDriveView}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:underline font-mono text-[11px]">Abrir no Drive ↗</a>` : ""}
                  </div>
                  <div class="p-3 sm:p-5 flex items-center justify-center bg-black/40 min-h-[220px]">
                    <img
                      src="${escapeHtml(srcPrimario)}"
                      alt="${escapeHtml(img.nome)}"
                      loading="lazy"
                      decoding="async"
                      class="w-full max-h-[840px] object-contain rounded-xl mx-auto"
                      onerror="if (this.dataset.tentativa !== '1' && '${escapeHtml(fallback1)}') { this.dataset.tentativa = '1'; this.src = '${escapeHtml(fallback1)}'; } else if (this.dataset.tentativa !== '2' && '${escapeHtml(fallback2)}') { this.dataset.tentativa = '2'; this.src = '${escapeHtml(fallback2)}'; }"
                    />
                  </div>
                </figure>
              `;
            }).join("")}
          </div>
        </div>
      `
      : criarAvisoFaltaItemHtml(
        "🖼️",
        "Falta PNG",
        "Nenhum infográfico ou diagrama .png foi encontrado nesta aula.",
        "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
      );

  // 3º PASSO: PDF (SOMENTE SEM OCR) OU AVISO "FALTA PDF SEM OCR"
  const blocoPdfsHtml = !exibirPdf
    ? ""
    : pdfsSemOcr.length > 0
      ? `
        <div class="space-y-4">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-rose-400">
              <span>📄 3. Slides & PDFs Visuais — Somente Sem OCR (${pdfsSemOcr.length})</span>
            </div>
            ${pdfsComOcrOcultados > 0 ? `<span class="text-[11px] font-mono text-notion-muted">${pdfsComOcrOcultados} PDF(s) com OCR ocultado(s) automaticamente</span>` : ""}
          </div>
          <div class="space-y-6">
            ${pdfsSemOcr.map(pdf => {
              const f = resolverFontesMidia(pdf, aula.id);
              const srcPdf = f.blobUrl || f.urlDrivePreview || f.urlLocalConfigurado || f.urlLocalDireto;
              const linkExterno = f.urlDriveView || f.blobUrl || f.urlLocalConfigurado;

              return `
                <div class="rounded-2xl bg-notion-bg border border-notion-border overflow-hidden shadow-xl">
                  <div class="px-4 py-3 border-b border-notion-border flex items-center justify-between gap-2 bg-notion-sidebar">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono text-[10px] shrink-0">🖼️ Sem OCR</span>
                      <span class="font-mono text-xs text-notion-text truncate font-semibold">${escapeHtml(pdf.nome)}</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      ${linkExterno ? `<a href="${escapeHtml(linkExterno)}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 rounded-lg bg-notion-card hover:bg-indigo-600 text-notion-text hover:text-white border border-notion-border text-[11px] font-mono transition-colors">Abrir em Nova Guia ↗</a>` : ""}
                    </div>
                  </div>
                  ${srcPdf ? `
                    <div class="w-full max-w-[940px] mx-auto h-[450px] sm:h-[490px] bg-zinc-900 overflow-hidden relative">
                      <iframe
                        data-src="${escapeHtml(srcPdf)}"
                        class="w-full h-full border-0 bg-zinc-900"
                        allow="autoplay; fullscreen"
                        allowfullscreen
                        loading="lazy"
                      ></iframe>
                    </div>
                  ` : `
                    <div class="p-8 text-center space-y-2 text-xs text-notion-muted">
                      <p class="text-amber-300 font-semibold">📄 Documento PDF aguardando sincronização de arquivo</p>
                      <p>Para visualizar este documento imediatamente, clique em <strong>"📁 Vincular Pasta Local"</strong> na barra lateral.</p>
                    </div>
                  `}
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `
      : criarAvisoFaltaItemHtml(
        "📄",
        "Falta PDF Sem OCR",
        pdfsComOcrOcultados > 0
          ? `Nenhum PDF Sem OCR nesta aula (${pdfsComOcrOcultados} PDF com OCR foi ocultado pelo filtro).`
          : "Nenhum slide ou documento PDF Sem OCR foi encontrado nesta aula.",
        "bg-rose-500/10 border-rose-500/40 text-rose-300"
      );

  // 4º PASSO: VÍDEO (.MP4, .MOV, .WEBM) OU AVISO "FALTA VÍDEO"
  const blocoVideosHtml = !exibirVideo
    ? ""
    : videos.length > 0
      ? `
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-purple-400">
            <span>🎬 4. Vídeo da Aula (${videos.length})</span>
          </div>
          <div class="space-y-5">
            ${videos.map(vid => {
              const f = resolverFontesMidia(vid, aula.id);
              const usarTagVideoNativa = Boolean(f.blobUrl || (!f.driveIdValido && f.urlLocalConfigurado));
              const srcVideoNativo = f.blobUrl || f.urlLocalConfigurado;

              return `
                <div class="rounded-2xl bg-notion-bg border border-notion-border overflow-hidden shadow-xl">
                  <div class="px-4 py-2.5 border-b border-notion-border flex items-center justify-between bg-notion-sidebar">
                    <span class="font-mono text-xs text-purple-300 truncate">🎬 ${escapeHtml(vid.nome)}</span>
                    ${f.urlDriveView ? `<a href="${f.urlDriveView}" target="_blank" rel="noopener noreferrer" class="text-[11px] font-mono text-indigo-400 hover:underline">Abrir no Drive ↗</a>` : ""}
                  </div>
                  <div class="aspect-video w-full bg-black">
                    ${usarTagVideoNativa ? `
                      <video controls preload="none" class="w-full h-full">
                        <source src="${escapeHtml(srcVideoNativo)}" type="video/mp4" />
                        <source src="${escapeHtml(f.urlLocalDireto)}" type="video/mp4" />
                      </video>
                    ` : f.urlDrivePreview ? `
                      <iframe
                        data-src="${escapeHtml(f.urlDrivePreview)}"
                        class="w-full h-full border-0"
                        allow="autoplay; fullscreen"
                        allowfullscreen
                        loading="lazy"
                      ></iframe>
                    ` : `
                      <div class="w-full h-full flex items-center justify-center p-6 text-center text-xs text-notion-muted">
                        🎬 Vídeo não vinculado online. Clique em <strong>"📁 Vincular Pasta Local"</strong> na barra lateral para reproduzir do disco.
                      </div>
                    `}
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `
      : criarAvisoFaltaItemHtml(
        "🎬",
        "Falta Vídeo",
        "Nenhum arquivo de vídeo (.mp4, .mov, .webm) foi encontrado nesta aula.",
        "bg-purple-500/10 border-purple-500/40 text-purple-300"
      );

  // 5º PASSO: ÁUDIO (.M4A, .MP3, .WAV) OU AVISO "FALTA M4A"
  const blocoAudiosHtml = !exibirAudio
    ? ""
    : audios.length > 0
      ? `
        <div class="space-y-4">
          <div class="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-pink-400">
            <span>🎧 5. Áudio / Podcast da Aula (${audios.length})</span>
          </div>
          <div class="space-y-3">
            ${audios.map((aud, idxAud) => {
              const f = resolverFontesMidia(aud, aula.id);
              const playerAudId = `lesson-audio-${aula.id}-${idxAud}`;
              const iframeAudId = `lesson-audio-fallback-${aula.id}-${idxAud}`;

              return `
                <div class="p-4 rounded-2xl bg-notion-bg border border-notion-border space-y-3 shadow-md">
                  <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="font-mono text-pink-300 font-semibold truncate">🎧 ${escapeHtml(aud.nome)}</span>
                    <div class="flex items-center gap-2 shrink-0">
                      ${f.urlDriveDownload ? `<a href="${f.urlDriveDownload}" target="_blank" rel="noopener noreferrer" class="text-[11px] font-mono text-pink-400 hover:underline">Baixar ⬇</a>` : ""}
                      ${f.urlDriveView ? `<a href="${f.urlDriveView}" target="_blank" rel="noopener noreferrer" class="text-[11px] font-mono text-indigo-400 hover:underline">Abrir no Drive ↗</a>` : ""}
                    </div>
                  </div>

                  ${f.blobUrl ? `
                    <audio controls preload="none" class="w-full">
                      <source src="${escapeHtml(f.blobUrl)}" />
                    </audio>
                  ` : f.driveIdValido ? `
                    <div class="space-y-2">
                      <audio id="${playerAudId}" controls preload="none" class="w-full"
                        onerror="document.getElementById('${iframeAudId}')?.classList.remove('hidden'); this.classList.add('hidden');">
                        <source src="${escapeHtml(f.urlDriveStream)}" type="audio/mp4" />
                        <source src="${escapeHtml(f.urlDriveDownload)}" type="audio/mpeg" />
                        <source src="${escapeHtml(f.urlDriveDirect)}" type="audio/mp4" />
                        ${f.urlLocalConfigurado ? `<source src="${escapeHtml(f.urlLocalConfigurado)}" />` : ""}
                      </audio>
                      <div id="${iframeAudId}" class="hidden space-y-1">
                        <iframe
                          data-src="${escapeHtml(f.urlDrivePreview)}"
                          class="w-full h-20 rounded-xl border border-notion-border bg-black"
                          allow="autoplay"
                          loading="lazy"
                        ></iframe>
                        <div class="text-[10px] font-mono text-notion-muted">Reproduzindo via Google Drive Preview Player</div>
                      </div>
                    </div>
                  ` : f.urlLocalConfigurado ? `
                    <audio controls preload="none" class="w-full">
                      <source src="${escapeHtml(f.urlLocalConfigurado)}" />
                      <source src="${escapeHtml(f.urlLocalDireto)}" />
                    </audio>
                  ` : `
                    <div class="text-xs text-notion-muted">Áudio aguardando ID do Google Drive ou vínculo da pasta local.</div>
                  `}
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `
      : criarAvisoFaltaItemHtml(
        "🎧",
        "Falta M4A",
        "Nenhum arquivo de áudio/podcast (.m4a, .mp3) foi encontrado nesta aula.",
        "bg-pink-500/10 border-pink-500/40 text-pink-300"
      );

  // 6º PASSO: LINK NOTEBOOKLM NO FINAL DA AULA OU AVISO "FALTA LINK NOTEBOOKLLM" + DRIVE DA AULA
  const linkNb = String(aula.linkNotebookLLM || "").trim();
  const linkDrive = String(aula.linkDrive || "").trim();
  const ehAdmin = isAdminAutenticado();
  const dupInfo = linkNb
    ? verificarLinkNotebookDuplicado(linkNb, disc.id, aula.id, store.getState().db)
    : { duplicado: false, totalOcorrencias: 0, outrasAulas: [] };

  const alertaDuplicadoHtml = (dupInfo.duplicado && ehAdmin)
    ? `
      <div class="mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5 text-xs text-amber-200">
        <span class="text-sm shrink-0">⚠️</span>
        <div class="space-y-0.5 min-w-0">
          <div class="font-bold">Link Compartilhado / Duplicado (${dupInfo.totalOcorrencias} aulas):</div>
          <div class="text-[11px] text-amber-300/80">
            ${dupInfo.outrasAulas.map(o => `<span>• <strong>${escapeHtml(o.discNome)}</strong> (${escapeHtml(o.aulaNome)})</span>`).join(" ")}
          </div>
        </div>
      </div>
    `
    : "";

  const driveSubBlockHtml = linkDrive
    ? `
      <div class="mt-3 pt-3 border-t border-indigo-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs">
        <div class="flex items-center gap-2 text-emerald-300 font-mono min-w-0">
          <span class="shrink-0">📁 Pasta / Arquivo Drive:</span>
          <span class="text-zinc-400 truncate max-w-md">${escapeHtml(linkDrive)}</span>
        </div>
        <a href="${escapeHtml(linkDrive)}" target="_blank" rel="noopener noreferrer" class="text-emerald-400 hover:text-emerald-300 font-mono text-xs flex items-center gap-1 shrink-0 transition-colors">
          <span>Abrir no Drive</span>
          <span>↗</span>
        </a>
      </div>
    `
    : "";

  const botaoEditarLinksHtml = ehAdmin
    ? `
      <button
        type="button"
        onclick="window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}')"
        class="px-3 py-1.5 rounded-lg bg-notion-card hover:bg-notion-hover border border-notion-border text-notion-text hover:text-white text-xs font-mono transition-colors flex items-center gap-1.5 cursor-pointer shrink-0"
        title="Editar Link do NotebookLM e Google Drive desta aula"
      >
        <span>✏️</span>
        <span>Editar Links</span>
      </button>
    `
    : "";

  const blocoNotebookHtml = !exibirNotebook
    ? ""
    : linkNb
      ? `
        <div class="p-5 rounded-2xl bg-gradient-to-r from-indigo-950/70 via-notion-bg to-violet-950/60 border border-indigo-500/40 shadow-lg space-y-2">
          <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div class="space-y-1 min-w-0">
              <div class="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-indigo-300">
                <span>🤖 6. Inteligência Artificial da Aula (NotebookLM)</span>
                ${dupInfo.duplicado ? `<span class="px-2 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/35 text-[10px]">Compartilhado (${dupInfo.totalOcorrencias})</span>` : ""}
              </div>
              <h4 class="text-sm font-bold text-white">Caderno Interativo desta Aula no Google NotebookLM</h4>
              <p class="text-xs text-notion-muted font-mono truncate max-w-xl">${escapeHtml(linkNb)}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${botaoEditarLinksHtml}
              <a href="${escapeHtml(linkNb)}" target="_blank" rel="noopener noreferrer" class="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md transition-all shrink-0 flex items-center gap-2">
                <span>Abrir NotebookLM</span>
                <span>↗</span>
              </a>
            </div>
          </div>
          ${alertaDuplicadoHtml}
          ${driveSubBlockHtml}
        </div>
      `
      : ehAdmin
        ? `
          <div class="p-4 rounded-2xl border bg-indigo-500/10 border-indigo-500/40 text-indigo-300 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-9 h-9 rounded-xl bg-black/30 border border-white/10 flex items-center justify-center text-lg shrink-0">🤖</span>
              <div class="min-w-0">
                <div class="font-mono text-xs font-bold uppercase tracking-wider text-white">Falta Link NotebookLLM</div>
                <div class="text-[11px] text-notion-muted truncate">Esta aula ainda não possui link do Google NotebookLM ou Google Drive cadastrado.</div>
              </div>
            </div>
            <button
              type="button"
              onclick="window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}')"
              class="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shrink-0 flex items-center gap-1.5 cursor-pointer"
            >
              <span>+ Vincular NotebookLM / Drive</span>
            </button>
          </div>
        `
        : "";

  // 7º PASSO: MATERIAL BRUTO UTILIZADO NA AULA (PDFs com OCR, Códigos Fonte & Textos) — RESTRITO AO MODO ADMIN (DIREITOS AUTORAIS)
  const blocoMaterialBrutoHtml = ehAdmin
    ? `
      <div class="p-5 rounded-2xl bg-gradient-to-r from-emerald-950/70 via-notion-bg to-teal-950/60 border border-emerald-500/40 shadow-lg space-y-2">
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div class="space-y-1 min-w-0">
            <div class="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-emerald-400 font-bold">
              <span>📂 7. Material Bruto Utilizado na Aula (Acesso Admin)</span>
            </div>
            <h4 class="text-sm font-bold text-white">PDFs com OCR, Códigos Fonte & Documentos Originais</h4>
            <p class="text-xs text-notion-muted font-mono truncate max-w-xl">
              Clique aqui para consultar os materiais brutos utilizados para estruturar esta aula.
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onclick="window.StudyOS?.abrirModalArquivosReferencias('${disc.id}', '${aula.id}')"
              class="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition-all shrink-0 flex items-center gap-2 cursor-pointer"
            >
              <span>Ver Material Bruto</span>
              <span>📂</span>
            </button>
          </div>
        </div>
      </div>
    `
    : "";

  const blocosVisiveis = [
    blocoMdHtml,
    blocoJpgHtml,
    blocoPngHtml,
    blocoPdfsHtml,
    blocoVideosHtml,
    blocoAudiosHtml,
    blocoNotebookHtml,
    blocoMaterialBrutoHtml
  ].filter(b => b && b.trim().length > 0);

  if (blocosVisiveis.length === 0) {
    return `
      <div class="py-8 px-4 text-center rounded-2xl bg-notion-bg/60 border border-notion-border space-y-2 my-3">
        <div class="text-2xl">📂</div>
        <div class="text-xs font-semibold text-notion-text">Nenhuma mídia disponível para os filtros selecionados.</div>
        <p class="text-[11px] text-notion-muted">Alterne os filtros de mídia acima ou consulte outras aulas desta matéria.</p>
      </div>
    `;
  }

  return `
    <div class="space-y-6 pt-3">
      ${blocosVisiveis.join("\n")}
    </div>
  `;
}

/**
 * Renderiza a barra horizontal de seleção das 6 mídias com contadores e estado ativo.
 */
export function renderBarraSelectsMidiaAula(disc) {
  if (typeof document === "undefined") return;
  const bar = document.getElementById("lesson-media-selects-bar");
  const badge = document.getElementById("media-filter-status-badge");
  const btnReset = document.getElementById("btn-reset-media-filter");
  const selectPreset = document.getElementById("select-media-preset");
  if (!bar) return;

  const state = store.getState();
  const contagemPorMidia = { md: 0, img: 0, pdf: 0, video: 0, audio: 0, notebook: 0 };
  if (disc && Array.isArray(disc.aulas)) {
    disc.aulas.forEach(aula => {
      if (aula.linkNotebookLLM) contagemPorMidia.notebook++;
      (aula.arquivos || []).forEach(arq => {
        const ext = String(arq.tipo || (arq.nome || "").split(".").pop() || "").toLowerCase();
        if (ext === "md" || ext === "markdown" || arq.conteudoTexto) contagemPorMidia.md++;
        else if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) contagemPorMidia.img++;
        else if (ext === "pdf" && (arq.temOCR === false || arq.statusOCR === "sem_ocr")) contagemPorMidia.pdf++;
        else if (["mp4", "mov", "webm"].includes(ext)) contagemPorMidia.video++;
        else if (["m4a", "mp3", "wav", "aac"].includes(ext)) contagemPorMidia.audio++;
      });
    });
  }

  const todasAtivas = state.midiasAtivasAula.size === OPCOES_MIDIA_AULA.length;

  bar.innerHTML = OPCOES_MIDIA_AULA.map((item, idx) => {
    const ativo = state.midiasAtivasAula.has(item.id);
    const qtd = contagemPorMidia[item.id] || 0;
    const setaHtml = idx < OPCOES_MIDIA_AULA.length - 1
      ? `<span class="text-[10px] text-notion-muted font-mono select-none hidden sm:inline">→</span>`
      : "";

    return `
      <button
        type="button"
        onclick="window.StudyOS?.alternarSelectMidiaAula('${item.id}')"
        title="Clique para filtrar ou somar '${item.label}' com outras mídias"
        class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono border transition-all cursor-pointer select-none ${
          ativo
            ? item.corAtiva
            : "bg-notion-bg/60 text-notion-muted border-notion-border opacity-55 hover:opacity-90 hover:text-notion-text"
        }"
      >
        <span class="text-[11px]">${ativo ? "☑️" : "⬜"}</span>
        <span>${item.icone}</span>
        <span class="font-semibold">${escapeHtml(item.label)}</span>
        <span class="text-[10px] px-1.5 py-0.2 rounded bg-black/30 text-notion-muted">${qtd}</span>
      </button>
      ${setaHtml}
    `;
  }).join("");

  if (badge) {
    if (todasAtivas) {
      badge.className = "text-[11px] text-emerald-300 font-mono bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded";
      badge.textContent = "⚡ Exibindo Todas as 6 Mídias (Clique em 1 ou mais ícones abaixo para filtrar)";
    } else {
      const nomesAtivos = OPCOES_MIDIA_AULA
        .filter(o => state.midiasAtivasAula.has(o.id))
        .map(o => `${o.icone} ${o.label}`)
        .join(" + ");
      badge.className = "text-[11px] text-amber-200 font-mono bg-amber-500/15 border border-amber-400/40 px-2.5 py-0.5 rounded";
      badge.textContent = `🎯 Filtro Ativo: ${nomesAtivos}`;
    }
  }

  if (btnReset) {
    btnReset.classList.toggle("hidden", todasAtivas);
  }

  if (selectPreset && todasAtivas) {
    selectPreset.value = "todas";
  }
}

/**
 * Renderiza o acordeão vertical contínuo das aulas de uma disciplina.
 */
export function renderDisciplineLessons(disc) {
  if (typeof document === "undefined") return;
  const tabsContainer = document.getElementById("disc-lessons-tabs");
  const listContainer = document.getElementById("disc-lessons-list");
  if (!tabsContainer || !listContainer) return;

  const state = store.getState();
  const aulas = disc.aulas || [];
  if (aulas.length === 0) {
    tabsContainer.innerHTML = "";
    listContainer.innerHTML = `
      <div class="p-8 rounded-2xl bg-notion-sidebar border border-notion-border text-center text-xs text-notion-muted">
        Nenhuma pasta de aula encontrada nesta matéria.
      </div>
    `;
    return;
  }

  tabsContainer.innerHTML = aulas.map(aula => {
    const aberta = state.aulasAbertas.has(aula.id);
    return `
      <button
        onclick="window.StudyOS?.abrirEFocarAula('${disc.id}', '${aula.id}')"
        id="tab-btn-${aula.id}"
        class="px-3 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap transition-all border cursor-pointer ${aberta ? 'bg-indigo-600 text-white border-indigo-400 shadow-xs' : 'bg-notion-card text-notion-muted hover:text-notion-text border-notion-border'}"
      >
        ${escapeHtml(aula.nome)}
      </button>
    `;
  }).join("");

  listContainer.innerHTML = aulas.map(aula => {
    const tituloH1 = obterTituloAula(aula, state.cacheMarkdownTexto);
    const aberta = state.aulasAbertas.has(aula.id);
    const arqs = aula.arquivos || [];
    const qtdMd = arqs.filter(a => a.tipo === "md").length;
    const qtdImg = arqs.filter(a => ["png", "jpg", "jpeg", "webp", "gif"].includes(a.tipo)).length;
    const qtdPdfSemOcr = arqs.filter(a => a.tipo === "pdf" && (a.temOCR === false || a.statusOCR === "sem_ocr")).length;
    const qtdVideo = arqs.filter(a => ["mp4", "mov", "webm"].includes(a.tipo)).length;
    const qtdAudio = arqs.filter(a => ["m4a", "mp3", "wav", "aac"].includes(a.tipo)).length;
    const stAula = calcularStatusAula(aula);
    const ehAdmin = isAdminAutenticado();

    return `
      <details
        id="lesson-details-${aula.id}"
        data-disc-id="${disc.id}"
        data-aula-id="${aula.id}"
        ${aberta ? "open" : ""}
        ontoggle="window.StudyOS?.aoAlternarToggleAula(this, '${disc.id}', '${aula.id}')"
        class="group rounded-2xl bg-notion-sidebar border border-notion-border open:border-indigo-500/50 transition-all overflow-hidden shadow-md"
      >
        <summary class="cursor-pointer select-none list-none outline-none block w-full hover:bg-notion-hover/40 transition-colors">
          <div class="p-3.5 sm:p-5 w-full flex flex-col gap-2.5">
            <!-- Linha 1: Arrow + Badges na Mesma Linha com Flex-Wrap -->
            <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap min-w-0">
              <span class="w-6 h-6 rounded-md bg-notion-card border border-notion-border flex items-center justify-center text-[10px] text-indigo-400 group-open:rotate-90 transition-transform shrink-0">
                ▶
              </span>
              <span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/35 font-mono font-bold text-[10px] tracking-wide shrink-0">
                ${escapeHtml(aula.nome)}
              </span>
              ${aula.data_aula
                ? ehAdmin
                  ? `<button type="button" onclick="event.stopPropagation(); window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}')" title="Data no Controle de Aulas (Notion) - Clique para editar" class="px-2 py-0.5 rounded bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/35 font-mono text-[10px] shrink-0 transition-colors flex items-center gap-1 cursor-pointer"><span>📅</span> <span>${escapeHtml(aula.data_aula)}</span> <span class="text-[9px] opacity-75">✏️</span></button>`
                  : `<span class="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/35 font-mono text-[10px] shrink-0 select-none" title="Data da Aula">📅 ${escapeHtml(aula.data_aula)}</span>`
                : ehAdmin
                  ? `<button type="button" onclick="event.stopPropagation(); window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}')" title="Definir Data da Aula no Notion" class="px-2 py-0.5 rounded bg-notion-card hover:bg-cyan-500/20 text-notion-muted hover:text-cyan-300 border border-notion-border font-mono text-[10px] shrink-0 transition-colors cursor-pointer"><span>📅</span> <span>+ Data</span></button>`
                  : ""}
              ${stAula.presenca
                ? `<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-[10px] shrink-0 font-semibold">✅ Presente</span>`
                : stAula.falta
                  ? `<span class="px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 font-mono text-[10px] shrink-0 font-bold">🟥 Falta</span>`
                  : ""
              }
              ${stAula.revisao ? `<span class="px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 font-mono text-[10px] shrink-0">🆗 Revisada</span>` : ""}
              ${qtdMd ? `<span class="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/25 font-mono text-[10px] shrink-0">📝 ${qtdMd} MD</span>` : ""}
              ${qtdImg ? `<span class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 font-mono text-[10px] shrink-0">🖼️ ${qtdImg}</span>` : ""}
              ${qtdPdfSemOcr ? `<span class="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/25 font-mono text-[10px] shrink-0">📄 ${qtdPdfSemOcr} PDF Sem OCR</span>` : ""}
              ${qtdVideo ? `<span class="px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/25 font-mono text-[10px] shrink-0">🎬 ${qtdVideo}</span>` : ""}
              ${qtdAudio ? `<span class="px-2 py-0.5 rounded bg-pink-500/10 text-pink-300 border border-pink-500/25 font-mono text-[10px] shrink-0">🎧 ${qtdAudio}</span>` : ""}
              ${aula.linkNotebookLLM
                ? (() => {
                    const dupInfo = verificarLinkNotebookDuplicado(aula.linkNotebookLLM, disc.id, aula.id, state.db);
                    const badgeDup = (dupInfo.duplicado && ehAdmin)
                      ? `<span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono text-[10px] shrink-0 cursor-help" title="Atenção: Link do NotebookLM compartilhado em ${dupInfo.totalOcorrencias} aulas (${dupInfo.outrasAulas.map(o => o.discNome + ' - ' + o.aulaNome).join(', ')})">⚠️ Compartilhado (${dupInfo.totalOcorrencias})</span>`
                      : "";
                    return `
                      <a href="${escapeHtml(aula.linkNotebookLLM)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();" title="Abrir NotebookLM desta aula" class="px-2 py-0.5 rounded bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-300 hover:text-white border border-indigo-500/30 font-mono text-[10px] shrink-0 transition-colors flex items-center gap-1 cursor-pointer">
                        <span>🤖 NotebookLM</span>
                        <span class="text-[9px]">↗</span>
                      </a>
                      ${badgeDup}
                    `;
                  })()
                : ehAdmin
                  ? `<button type="button" onclick="event.stopPropagation(); window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}')" title="Adicionar link do NotebookLM ou Drive" class="px-2 py-0.5 rounded bg-notion-card hover:bg-indigo-500/20 text-notion-muted hover:text-indigo-300 border border-notion-border font-mono text-[10px] shrink-0 transition-colors cursor-pointer flex items-center gap-1">
                      <span>🤖</span> <span>+ Link</span>
                    </button>`
                  : ""
              }
              ${aula.linkDrive
                ? `<a href="${escapeHtml(aula.linkDrive)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();" title="Abrir Google Drive desta aula" class="px-2 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 hover:text-white border border-emerald-500/30 font-mono text-[10px] shrink-0 transition-colors flex items-center gap-1 cursor-pointer">
                    <span>📁 Drive</span>
                    <span class="text-[9px]">↗</span>
                  </a>`
                : ""
              }
            </div>

            <!-- Linha 2: Título com Largura Total -->
            <div class="pl-8 w-full min-w-0">
              <h2 class="text-base sm:text-xl font-bold text-notion-text tracking-tight leading-snug break-words">
                ${escapeHtml(tituloH1)}
              </h2>
            </div>
          </div>
        </summary>

        <!-- Corpo Lazy: Vazio quando fechado, preenchido sob demanda quando aberto -->
        <div id="lesson-body-${aula.id}" class="px-3 sm:px-6 pb-6 border-t border-notion-border/60">
          ${aberta ? montarConteudoInternoDaAula(disc, aula) : ""}
        </div>
      </details>
    `;
  }).join("");
}

/**
 * Trata a alternância de abertura/fechamento de uma aula no acordeão.
 * Limpa o DOM interno e revoga os Blob URLs para economizar memória quando fechada.
 */
export function aoAlternarToggleAula(detailsEl, disc, aulaId) {
  const bodyEl = document.getElementById(`lesson-body-${aulaId}`);
  const tabBtn = document.getElementById(`tab-btn-${aulaId}`);
  if (!disc || !bodyEl) return;

  const aula = (disc.aulas || []).find(a => a.id === aulaId);
  if (!aula) return;

  const state = store.getState();

  if (detailsEl.open) {
    state.aulasAbertas.add(aulaId);
    if (!bodyEl.innerHTML.trim()) {
      bodyEl.innerHTML = montarConteudoInternoDaAula(disc, aula);
    }
    observarMidiasLazy(bodyEl);
    if (tabBtn) {
      tabBtn.className = "px-3 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap transition-all border bg-indigo-600 text-white border-indigo-400 shadow-xs cursor-pointer";
    }
  } else {
    state.aulasAbertas.delete(aulaId);
    bodyEl.innerHTML = "";
    revogarBlobsDaAula(aulaId);
    if (tabBtn) {
      tabBtn.className = "px-3 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap transition-all border bg-notion-card text-notion-muted hover:text-notion-text border-notion-border cursor-pointer";
    }
  }
}
