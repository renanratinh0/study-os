/**
 * Study OS V2 - Arquivos & Referências Modal
 * Modal inteligente que realiza o parsing do Bloco 15 do Markdown da aula
 * (> Arquivos utilizados: e referências a PDFs com OCR, slides, códigos, áudios)
 * com cruzamento automático aos arquivos físicos e regra de fallback elegante.
 */

import { store, buscarDisciplinaPorId } from "../core/store.js";
import { resolverInventarioArquivosAula } from "../utils/markdownParser.js";
import { resolverFontesMidia } from "../services/mediaResolver.js";
import { escapeHtml, mostrarToast, obterTituloAula } from "../utils/domHelpers.js";
import { isAdminAutenticado } from "../services/auth.js";
import { classificarArquivoArtefato } from "../utils/artifactsClassifier.js";

let _modalElemento = null;

function obterOuCriarModal() {
  if (typeof document === "undefined") return null;
  let modal = document.getElementById("modal-arquivos-referencias");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modal-arquivos-referencias";
    modal.className = "fixed inset-0 z-50 hidden items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-6 overflow-y-auto animate-fade-in";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
  }
  _modalElemento = modal;
  return modal;
}

/**
 * Abre o modal de Arquivos & Referências da aula especificada.
 * @param {string} discId
 * @param {string} aulaId
 */
export function abrirModalArquivosReferencias(discId, aulaId) {
  if (typeof document === "undefined") return;
  if (!isAdminAutenticado()) {
    mostrarToast("Acesso Restrito", "O Material Bruto (PDFs com OCR e documentos originais) é restrito ao Modo Administrador por direitos autorais.", "info");
    return;
  }
  const modal = obterOuCriarModal();
  if (!modal) return;

  const state = store.getState();
  const disc = buscarDisciplinaPorId(discId);
  if (!disc) {
    mostrarToast("Atenção", "Matéria não encontrada.", "error");
    return;
  }

  const aula = (disc.aulas || []).find(a => a.id === aulaId);
  if (!aula) {
    mostrarToast("Atenção", "Aula não encontrada.", "error");
    return;
  }

  // Obtém o texto Markdown da aula a partir dos arquivos ou do cache de edição (excluindo flashcards/quiz/relatorio)
  let textoMd = "";
  const arqMd = (aula.arquivos || []).find(a => a.tipo === "md" && !classificarArquivoArtefato(a).ehNovoArtefato);
  if (arqMd) {
    const cacheKey = arqMd.id || arqMd.local || arqMd.nome;
    textoMd = state.cacheMarkdownTexto[cacheKey] ?? arqMd.conteudoTexto ?? "";
  }

  const inventario = resolverInventarioArquivosAula(aula, textoMd);
  const tituloH1 = obterTituloAula(aula, state.cacheMarkdownTexto);
  const ehAdmin = isAdminAutenticado();

  modal.innerHTML = `
    <div class="relative w-full max-w-4xl max-h-[90vh] bg-notion-sidebar border border-indigo-500/30 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-notion-text">
      <!-- CABEÇALHO DO MODAL -->
      <div class="px-5 py-4 border-b border-notion-border flex items-center justify-between gap-4 bg-gradient-to-r from-indigo-950/40 via-notion-bg to-zinc-950 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <span class="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-xl shrink-0">
            📂
          </span>
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs font-mono text-indigo-400 font-semibold">${escapeHtml(disc.icone)} ${escapeHtml(disc.nome)}</span>
              <span class="text-notion-muted text-xs">&bull;</span>
              <span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono text-[10px] font-bold">${escapeHtml(aula.nome)}</span>
              ${inventario.temBloco15
                ? `<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-[10px]">✨ Bloco 15 Mapeado</span>`
                : `<span class="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono text-[10px]">ℹ️ Fallback Automático</span>`
              }
            </div>
            <h3 class="text-base sm:text-lg font-bold text-white truncate max-w-xl mt-0.5">
              ${escapeHtml(tituloH1)}
            </h3>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onclick="window.StudyOS?.fecharModalArquivosReferencias()"
            class="w-8 h-8 rounded-lg bg-notion-card hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border flex items-center justify-center text-sm transition-colors cursor-pointer"
            title="Fechar (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      <!-- CORPO COM ROLAGEM -->
      <div class="p-5 sm:p-6 overflow-y-auto space-y-5 flex-1">
        <!-- BARRA DE ATALHOS RÁPIDOS DA AULA -->
        <div class="p-3.5 rounded-xl bg-notion-card border border-notion-border flex flex-wrap items-center justify-between gap-3 text-xs">
          <div class="flex items-center gap-2 flex-wrap font-mono text-[11px]">
            <span class="text-notion-muted">Total de Arquivos:</span>
            <span class="px-2 py-0.5 rounded bg-black/40 text-white font-bold border border-white/10">${inventario.totalArquivos}</span>
            ${aula.linkDrive
              ? `<a href="${escapeHtml(aula.linkDrive)}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5 transition-colors">
                  <span>📁 Pasta no Google Drive</span>
                  <span>↗</span>
                </a>`
              : ""
            }
            ${aula.linkNotebookLLM
              ? `<a href="${escapeHtml(aula.linkNotebookLLM)}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 flex items-center gap-1.5 transition-colors">
                  <span>🤖 NotebookLM</span>
                  <span>↗</span>
                </a>`
              : ""
            }
          </div>

          ${ehAdmin
            ? `<button
                type="button"
                onclick="window.StudyOS?.abrirModalDataAula('${disc.id}', '${aula.id}'); window.StudyOS?.fecharModalArquivosReferencias();"
                class="px-2.5 py-1 rounded-lg bg-notion-bg hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border font-mono text-[11px] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <span>✏️</span>
                <span>Editar Metadados / Links</span>
              </button>`
            : ""
          }
        </div>

        <!-- AVISO DE INFORMAÇÃO / FALLBACK -->
        ${!inventario.temBloco15
          ? `
            <div class="p-4 rounded-xl bg-gradient-to-r from-amber-500/10 via-notion-bg to-amber-500/5 border border-amber-500/30 space-y-1">
              <div class="flex items-center gap-2 text-xs font-bold text-amber-300">
                <span>💡</span>
                <span>Modo de Detecção Automática (Fallback Ativo)</span>
              </div>
              <p class="text-xs text-notion-muted leading-relaxed">
                Esta aula ainda não possui a seção estruturada <strong>"### 📂 15. Arquivos e Referências"</strong> no corpo do Markdown. O Study OS identificou automaticamente todos os arquivos físicos catalogados na pasta da aula para você acessá-los sem interrupção.
              </p>
            </div>
          `
          : `
            <div class="flex items-center justify-between text-xs text-notion-muted">
              <div class="flex items-center gap-1.5 font-mono">
                <span class="text-indigo-400">📋</span>
                <span class="font-semibold text-white">${escapeHtml(inventario.titulo)}</span>
              </div>
              <span class="text-[11px] font-mono">${inventario.arquivos.length} itens referenciados</span>
            </div>
          `
        }

        <!-- LISTA PRINCIPAL DE ARQUIVOS (BLOCO 15 OU FALLBACK) -->
        ${inventario.arquivos.length === 0
          ? `
            <div class="p-8 rounded-xl bg-notion-card border border-notion-border text-center space-y-2">
              <div class="text-2xl">📭</div>
              <div class="text-xs font-bold text-notion-text">Nenhum arquivo encontrado nesta aula.</div>
              <p class="text-[11px] text-notion-muted">Esta pasta de aula não possui arquivos físicos registrados no banco.</p>
            </div>
          `
          : `
            <div class="space-y-2.5">
              ${inventario.arquivos.map((item, idx) => {
                const arqDb = item.arquivoDb;
                const f = arqDb ? resolverFontesMidia(arqDb, aula.id) : null;
                const urlDrive = f?.urlDriveView || f?.urlDriveDownload || item.linkExterno || "";
                const temDrive = Boolean(urlDrive);

                return `
                  <div class="p-3.5 rounded-xl bg-notion-card border border-notion-border hover:border-indigo-500/40 transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
                    <div class="flex items-center gap-3 min-w-0">
                      <span class="w-9 h-9 rounded-lg bg-notion-bg border border-white/10 flex items-center justify-center text-lg shrink-0">
                        ${item.icone}
                      </span>
                      <div class="min-w-0 space-y-0.5">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="font-mono text-xs font-bold text-white truncate max-w-md">${escapeHtml(item.nome)}</span>
                          <span class="px-1.5 py-0.2 rounded bg-black/30 text-notion-muted border border-white/10 font-mono text-[9px] uppercase">${escapeHtml(item.ext || 'arq')}</span>
                          ${arqDb?.temOCR === false || arqDb?.statusOCR === "sem_ocr"
                            ? `<span class="px-1.5 py-0.2 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 font-mono text-[9px]">Sem OCR</span>`
                            : ""
                          }
                          ${arqDb?.temOCR
                            ? `<span class="px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono text-[9px]">OCR Ativo</span>`
                            : ""
                          }
                        </div>
                        <div class="text-[11px] text-notion-muted flex items-center gap-2 truncate">
                          <span>${escapeHtml(item.descricao)}</span>
                        </div>
                      </div>
                    </div>

                    <div class="flex items-center gap-2 shrink-0 self-end sm:self-center font-mono text-xs">
                      ${temDrive
                        ? `<a
                            href="${escapeHtml(urlDrive)}"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-all flex items-center gap-1.5 shadow-sm"
                          >
                            <span>Abrir no Drive</span>
                            <span>↗</span>
                          </a>`
                        : aula.linkDrive
                          ? `<a
                              href="${escapeHtml(aula.linkDrive)}"
                              target="_blank"
                              rel="noopener noreferrer"
                              class="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-white font-semibold transition-all flex items-center gap-1.5 shadow-sm"
                              title="Abrir a pasta do Google Drive desta aula onde o arquivo está salvo"
                            >
                              <span>📁 Pasta do Drive</span>
                              <span>↗</span>
                            </a>`
                          : f?.blobUrl
                            ? `<a
                                href="${escapeHtml(f.blobUrl)}"
                                download="${escapeHtml(item.nome)}"
                                class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition-all flex items-center gap-1.5 shadow-sm"
                              >
                                <span>Baixar Arquivo</span>
                                <span>⬇</span>
                              </a>`
                            : `<a
                                href="https://drive.google.com/drive/search?q=${encodeURIComponent(item.nome)}"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="px-3 py-1.5 rounded-lg bg-indigo-600/80 hover:bg-indigo-500 text-white font-semibold transition-all flex items-center gap-1.5 shadow-sm"
                                title="Pesquisar este arquivo no seu Google Drive"
                              >
                                <span>Buscar no Drive</span>
                                <span>🔍</span>
                              </a>`
                      }
                      ${f?.urlDriveDownload && f.urlDriveDownload !== urlDrive
                        ? `<a
                            href="${escapeHtml(f.urlDriveDownload)}"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="px-2.5 py-1.5 rounded-lg bg-notion-bg hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border transition-colors text-[11px]"
                            title="Baixar direto do Google Drive"
                          >
                            ⬇
                          </a>`
                        : ""
                      }
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          `
        }

        <!-- ARQUIVOS EXTRAS DETECTADOS NA PASTA QUE NÃO CONSTAM NO BLOCO 15 -->
        ${inventario.extrasSemBloco15.length > 0
          ? `
            <details class="rounded-xl bg-notion-card/60 border border-notion-border overflow-hidden">
              <summary class="px-4 py-3 cursor-pointer text-xs font-mono text-notion-muted hover:text-white flex items-center justify-between select-none">
                <span>📂 Outros arquivos detectados na pasta (${inventario.extrasSemBloco15.length})</span>
                <span class="text-[10px] text-indigo-400">Clique para expandir</span>
              </summary>
              <div class="p-3 border-t border-notion-border/60 space-y-2">
                ${inventario.extrasSemBloco15.map(extra => {
                  const f = resolverFontesMidia(extra.arquivoDb, aula.id);
                  const urlLink = f.urlDriveView || f.urlDriveDownload || f.blobUrl || "";
                  return `
                    <div class="p-2.5 rounded-lg bg-notion-bg/60 border border-notion-border/40 flex items-center justify-between gap-2 text-xs">
                      <div class="flex items-center gap-2 min-w-0">
                        <span>${extra.icone}</span>
                        <span class="font-mono text-notion-text truncate">${escapeHtml(extra.nome)}</span>
                      </div>
                      ${urlLink
                        ? `<a href="${escapeHtml(urlLink)}" target="_blank" rel="noopener noreferrer" class="text-emerald-400 hover:underline font-mono text-[11px] shrink-0">Abrir ↗</a>`
                        : aula.linkDrive
                          ? `<a href="${escapeHtml(aula.linkDrive)}" target="_blank" rel="noopener noreferrer" class="text-emerald-400 hover:underline font-mono text-[11px] shrink-0">Pasta do Drive ↗</a>`
                          : `<a href="https://drive.google.com/drive/search?q=${encodeURIComponent(extra.nome)}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:underline font-mono text-[11px] shrink-0">Buscar no Drive 🔍</a>`
                      }
                    </div>
                  `;
                }).join("")}
              </div>
            </details>
          `
          : ""
        }
      </div>

      <!-- RODAPÉ DO MODAL -->
      <div class="px-5 py-3 border-t border-notion-border bg-notion-card/60 flex items-center justify-between gap-3 text-xs shrink-0">
        <div class="text-notion-muted text-[11px] font-mono">
          <span>Padrão Study OS &bull; Bloco 15 de Rastreabilidade</span>
        </div>
        <button
          type="button"
          onclick="window.StudyOS?.fecharModalArquivosReferencias()"
          class="px-4 py-2 rounded-lg bg-notion-card hover:bg-notion-hover text-white font-mono text-xs border border-notion-border transition-colors cursor-pointer"
        >
          Fechar
        </button>
      </div>
    </div>
  `;

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

/**
 * Fecha o modal de Arquivos & Referências.
 */
export function fecharModalArquivosReferencias() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-arquivos-referencias");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}
