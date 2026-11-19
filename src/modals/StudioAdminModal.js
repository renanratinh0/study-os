/**
 * Study OS V2 — Studio Admin Modal (Painel de Aprovação Diff A/B, Lote & Relatório de Fontes)
 * Carregado sob demanda via Dynamic Import (`import()`).
 *
 * FASE 3 IMPLEMENTADA:
 * - Visualizador Comparativo Lado a Lado (Diff A/B):
 *   - Se for Regeração (`url_antiga` presente): exibe Lado a Lado a Versão Antiga (esquerda)
 *     e a Versão Nova em `staging/` (direita) usando `<img>` (PNG), `<video>` (MP4),
 *     `<audio>` (M4A) e `<iframe>` (PDF).
 *   - Se for Geração Nova (sem `url_antiga`): exibe apenas o preview do arquivo novo.
 *   - Regra de Não-Visuais: `flashcards.md`, `quiz.md`, `mapa-mental.json` e `relatorio.md`
 *     vão direto sem precisar de aprovação manual.
 * - Exclusivamente 3 Botões por Card de Revisão:
 *   1. `[✅ Aprovar]`
 *   2. `[🔄 Tentar de Novo]`
 *   3. `[✖]` (Botão X no canto do card)
 */

import { store, obterTodasDisciplinas, buscarDisciplinaPorId } from "../core/store.js";
import { escapeHtml, mostrarToast } from "../utils/domHelpers.js";
import {
  STUDIO_ARTIFACT_TYPES,
  ORDEM_EXECUCAO_ARTEFATOS_STUDIO,
  MAPA_TIPOS_STUDIO,
  getStudioWorkerUrl,
  obterContadoresStudio,
  listarJobsStudioLocal,
  sincronizarFilaComWorker,
  aprovarJobRevisaoStudio,
  tentarNovamenteJobRevisaoStudio,
  cancelarJobRevisaoStudio,
  retomarFilaCotaStudio,
  simularLoteStudio,
  dispararLoteStudio,
  consultarRelatorioFontesNotebook
} from "../services/studioApi.js";

/**
 * Renderiza a tag de mídia apropriada (`<img>`, `<video>`, `<audio>`, `<iframe>`)
 * tanto para a versão antiga quanto para a versão nova em `staging/`.
 */
export function renderMidiaPreviewTagHtml(tipoArtefato, urlMidia, rotulo = "Preview", stagingDriveId = "") {
  const driveId = String(stagingDriveId || "").trim();
  let srcLimpo = String(urlMidia || "").trim();

  if (!srcLimpo && driveId) {
    const tipoLow = String(tipoArtefato || "").toLowerCase();
    if (tipoLow === "infografico") srcLimpo = `https://lh3.googleusercontent.com/d/${driveId}=w2000`;
    else if (tipoLow === "audio") srcLimpo = `https://docs.google.com/uc?export=open&id=${driveId}`;
    else srcLimpo = `https://drive.google.com/file/d/${driveId}/preview`;
  }

  if (!srcLimpo) {
    return `
      <div class="p-6 rounded-xl bg-black/40 border border-white/10 text-center text-xs text-notion-muted font-mono">
        Nenhum arquivo anterior (${escapeHtml(rotulo)})
      </div>
    `;
  }

  const workerBase = getStudioWorkerUrl();
  const srcResolvido = srcLimpo.startsWith("staging/")
    ? `${workerBase}/${srcLimpo}`
    : srcLimpo;

  const tipo = String(tipoArtefato || "").toLowerCase();

  if (tipo === "infografico" || /\.(png|jpe?g|webp|gif)$/i.test(srcLimpo) || srcLimpo.includes("googleusercontent.com")) {
    return `
      <div class="rounded-xl overflow-hidden bg-black/60 border border-white/10 flex items-center justify-center p-2 min-h-[220px]">
        <img
          src="${escapeHtml(srcResolvido)}"
          alt="${escapeHtml(rotulo)}"
          class="max-h-[380px] w-auto object-contain rounded-lg"
        />
      </div>
    `;
  }

  if (tipo === "video" || /\.(mp4|mov|webm)$/i.test(srcLimpo)) {
    if (srcResolvido.includes("drive.google.com/file")) {
      return `
        <div class="rounded-xl overflow-hidden bg-black border border-white/10 aspect-video w-full">
          <iframe src="${escapeHtml(srcResolvido)}" class="w-full h-full border-0" allow="autoplay; fullscreen"></iframe>
        </div>
      `;
    }
    return `
      <div class="rounded-xl overflow-hidden bg-black border border-white/10 aspect-video w-full">
        <video controls preload="metadata" class="w-full h-full" src="${escapeHtml(srcResolvido)}">
          <source src="${escapeHtml(srcResolvido)}" type="video/mp4" />
        </video>
      </div>
    `;
  }

  if (tipo === "audio" || /\.(m4a|mp3|wav|aac)$/i.test(srcLimpo)) {
    return `
      <div class="p-4 rounded-xl bg-black/60 border border-white/10 space-y-2">
        <div class="text-[11px] font-mono text-pink-300 truncate">🎧 ${escapeHtml(rotulo)}</div>
        <audio controls preload="metadata" class="w-full" src="${escapeHtml(srcResolvido)}">
          <source src="${escapeHtml(srcResolvido)}" type="audio/mp4" />
        </audio>
      </div>
    `;
  }

  if (tipo === "slides" || /\.pdf($|\?)/i.test(srcLimpo) || srcLimpo.includes("/preview")) {
    return `
      <div class="rounded-xl overflow-hidden bg-zinc-900 border border-white/10 w-full h-[340px]">
        <iframe
          src="${escapeHtml(srcResolvido)}"
          class="w-full h-full border-0"
          allow="fullscreen"
          title="${escapeHtml(rotulo)}"
        ></iframe>
      </div>
    `;
  }

  return `
    <div class="p-4 rounded-xl bg-black/50 border border-white/10 font-mono text-xs text-zinc-300 break-all">
      ${escapeHtml(srcResolvido)}
    </div>
  `;
}

/**
 * Renderiza o HTML de um Card de Revisão com Diff A/B e estritamente os 3 botões:
 * `[✅ Aprovar]`, `[🔄 Tentar de Novo]` e `[✖]`.
 */
export function renderCardRevisaoDiffHtml(job) {
  const meta = MAPA_TIPOS_STUDIO[job.tipo_artefato] || {
    icone: "📦",
    labelCompleto: job.tipo_artefato
  };
  const ehRegeracao = Boolean(job.url_antiga && String(job.url_antiga).trim().length > 0);
  const urlStaging = job.staging_drive_url || job.caminho_staging || `staging/${job.id}_${job.tipo_artefato}.${meta.extensao || "dat"}`;
  const configResumo = job.config_geracao?.resumo_label || "";

  const comparativoHtml = ehRegeracao
    ? `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4" data-diff-mode="side-by-side">
        <!-- Lado Esquerdo: Versão Antiga (Atual no Banco) -->
        <div class="p-3.5 rounded-xl bg-black/40 border border-rose-500/30 space-y-2">
          <div class="flex items-center justify-between text-xs font-mono">
            <span class="px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 font-bold">
              ⬅️ Versão Antiga (Atual no Banco)
            </span>
            <span class="text-[10px] text-notion-muted truncate max-w-[200px]">${escapeHtml(job.url_antiga)}</span>
          </div>
          ${renderMidiaPreviewTagHtml(job.tipo_artefato, job.url_antiga, "Versão Antiga")}
        </div>

        <!-- Lado Direito: Versão Nova (staging / Google Drive) -->
        <div class="p-3.5 rounded-xl bg-black/40 border border-emerald-500/40 space-y-2">
          <div class="flex items-center justify-between text-xs font-mono">
            <span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold">
              ➡️ Versão Nova (${job.staging_drive_url ? "Google Drive Staging" : "staging/"})
            </span>
            <span class="text-[10px] text-notion-muted truncate max-w-[200px]">${escapeHtml(urlStaging)}</span>
          </div>
          ${renderMidiaPreviewTagHtml(job.tipo_artefato, urlStaging, "Versão Nova (Staging)", job.staging_drive_id)}
        </div>
      </div>
    `
    : `
      <div class="p-3.5 rounded-xl bg-black/40 border border-emerald-500/40 space-y-2" data-diff-mode="single-new">
        <div class="flex items-center justify-between text-xs font-mono">
          <span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold">
            ✨ Nova Geração (${job.staging_drive_url ? "Google Drive Staging" : "staging/"})
          </span>
          <span class="text-[10px] text-notion-muted truncate max-w-[260px]">${escapeHtml(urlStaging)}</span>
        </div>
        ${renderMidiaPreviewTagHtml(job.tipo_artefato, urlStaging, "Novo Artefato Gerado", job.staging_drive_id)}
      </div>
    `;

  return `
    <div id="studio-review-card-${escapeHtml(job.id)}" data-review-card-id="${escapeHtml(job.id)}" class="p-4 sm:p-5 rounded-2xl bg-notion-card border border-notion-border space-y-4 relative shadow-xl">
      <!-- Cabeçalho do Card + Botão 3: [✖] no canto superior direito -->
      <div class="flex items-start justify-between gap-3 border-b border-notion-border pb-3">
        <div class="space-y-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/35 font-mono text-[10px] font-bold">
              ${meta.icone} ${escapeHtml(meta.labelCompleto)}
            </span>
            <span class="px-2 py-0.5 rounded ${ehRegeracao ? "bg-amber-500/20 text-amber-300 border-amber-500/35" : "bg-emerald-500/20 text-emerald-300 border-emerald-500/35"} border font-mono text-[10px] font-bold uppercase">
              ${ehRegeracao ? "🔄 Regeração (Diff A/B)" : "➕ Geração Nova"}
            </span>
            ${configResumo ? `<span class="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono text-[10px]">⚙️ ${escapeHtml(configResumo)}</span>` : ""}
          </div>
          <h4 class="text-sm font-bold text-white truncate">
            ${escapeHtml(job.materia_nome || job.materia_id)} &bull; ${escapeHtml(job.aula_nome || job.aula_id)}
          </h4>
        </div>

        <!-- Botão 3: [✖] Cancela/apaga solicitação e mantém arquivo antigo intacto -->
        <button
          type="button"
          data-studio-review-action="cancelar"
          data-job-id="${escapeHtml(job.id)}"
          onclick="window.StudyOS?.cancelarJobRevisaoStudio('${escapeHtml(job.id)}')"
          title="Cancelar solicitação, excluir arquivo do staging/ e manter versão antiga intacta no banco"
          class="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/30 font-mono text-xs font-bold transition-all cursor-pointer shrink-0"
        >
          ✖
        </button>
      </div>

      <!-- Visualizador Comparativo (Diff Antigo vs. Novo ou Preview Único) -->
      ${comparativoHtml}

      <!-- Rodapé com os Botões 1 e 2 ([✅ Aprovar] e [🔄 Tentar de Novo]) -->
      <div class="flex items-center justify-end gap-3 pt-2 border-t border-notion-border/60">
        <button
          type="button"
          data-studio-review-action="tentar-novamente"
          data-job-id="${escapeHtml(job.id)}"
          onclick="window.StudyOS?.tentarNovamenteJobRevisaoStudio('${escapeHtml(job.id)}')"
          class="px-4 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500 text-amber-200 hover:text-black border border-amber-500/40 font-mono text-xs font-bold transition-all cursor-pointer"
        >
          🔄 Tentar de Novo
        </button>
        <button
          type="button"
          data-studio-review-action="aprovar"
          data-job-id="${escapeHtml(job.id)}"
          onclick="window.StudyOS?.aprovarJobRevisaoStudio('${escapeHtml(job.id)}')"
          class="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-bold shadow-lg transition-all cursor-pointer"
        >
          ✅ Aprovar
        </button>
      </div>
    </div>
  `;
}

/**
 * Garante que o container do Modal de Revisão exista no DOM e renderiza os cards em `revisao`.
 */
function ensureModalRevisaoDOM() {
  let modal = document.getElementById("modal-studio-revisao");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "modal-studio-revisao";
  modal.className = "fixed inset-0 bg-black/85 backdrop-blur-md z-[110] hidden items-center justify-center p-3 sm:p-6";
  modal.innerHTML = `
    <div class="bg-notion-sidebar w-full max-w-6xl rounded-2xl shadow-2xl border border-notion-border overflow-hidden flex flex-col max-h-[92vh]">
      <div class="p-4 sm:p-5 border-b border-notion-border bg-gradient-to-r from-indigo-950/50 via-notion-sidebar to-emerald-950/40 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-xl shrink-0">
            👁️
          </div>
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="text-base font-bold text-white">Painel de Aprovação Simplificado (Diff A/B)</h3>
              <span class="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono text-[10px]">
                ⚡ Flashcards, Quiz, Mapa Mental e Relatório vão direto sem revisão
              </span>
            </div>
            <p id="studio-modal-header-counters" class="text-[11px] font-mono text-notion-muted mt-0.5">
              Fila: 0 | Para Revisar: 0 | Cota: OK
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onclick="window.StudyOS?.retomarFilaCotaStudio()"
            class="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/35 font-mono text-xs cursor-pointer transition-colors"
            title="Retomar imediatamente itens que estavam em aguardando_cota"
          >
            ▶️ Retomar Cota
          </button>
          <button
            type="button"
            onclick="window.StudyOS?.limparFilaStudioCompleta()"
            class="px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/35 font-mono text-xs cursor-pointer transition-colors"
            title="Zerar todos os itens pendentes na fila local e no Firebase (/fila_studio)"
          >
            🗑️ Limpar Fila
          </button>
          <button
            type="button"
            onclick="window.StudyOS?.abrirModalStudioLote()"
            class="px-3 py-1.5 rounded-xl bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 hover:text-white border border-indigo-500/40 font-mono text-xs cursor-pointer transition-colors"
          >
            📦 Gerar/Regerar em Lote
          </button>
          <button
            type="button"
            onclick="window.StudyOS?.fecharModalStudioRevisao()"
            class="p-1.5 rounded-lg hover:bg-notion-hover text-notion-muted hover:text-white transition-colors cursor-pointer text-sm"
          >
            ✕
          </button>
        </div>
      </div>

      <div id="modal-studio-revisao-body" class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 text-xs">
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

export async function abrirModalStudioRevisao() {
  if (typeof document === "undefined") return;
  const modal = ensureModalRevisaoDOM();
  await sincronizarFilaComWorker({ forcar: true });
  renderCorpoModalStudioRevisao();
  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

export function fecharModalStudioRevisao() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-studio-revisao");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

export function renderCorpoModalStudioRevisao() {
  if (typeof document === "undefined") return;
  const bodyEl = document.getElementById("modal-studio-revisao-body");
  if (!bodyEl) return;

  const itensRevisao = listarJobsStudioLocal(true);
  const todosAtivos = listarJobsStudioLocal(false);
  const contadores = obterContadoresStudio();

  const headerCounters = document.getElementById("studio-modal-header-counters");
  if (headerCounters) {
    headerCounters.textContent = `Fila: ${contadores.totalFila} (Na Fila: ${contadores.na_fila} • Gerando: ${contadores.gerando} • Aguardando Cota: ${contadores.aguardando_cota}) | Para Revisar: ${contadores.revisao} | Cota: ${contadores.cota_status}`;
  }

  const resumoFilaHtml = contadores.totalFila > 0
    ? `
      <div class="p-3.5 rounded-xl bg-indigo-950/30 border border-indigo-500/30 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
        <div class="flex items-center gap-2 text-indigo-200">
          <span>⏳</span>
          <span>Processando em background: <strong>${contadores.na_fila}</strong> na fila, <strong>${contadores.gerando}</strong> gerando agora, <strong>${contadores.aguardando_cota}</strong> aguardando cota.</span>
        </div>
        <span class="text-[11px] text-notion-muted">Total ativos: ${todosAtivos.length}</span>
      </div>
    `
    : "";

  if (itensRevisao.length === 0) {
    bodyEl.innerHTML = `
      ${resumoFilaHtml}
      <div class="p-10 rounded-2xl bg-notion-bg/70 border border-notion-border text-center space-y-2">
        <div class="text-3xl">✨</div>
        <h4 class="text-sm font-bold text-white">Nenhum artefato visual pendente de revisão</h4>
        <p class="text-xs text-notion-muted max-w-lg mx-auto">
          Quando novos infográficos (PNG), apresentações de slides (PDF), vídeos (MP4) ou áudios (M4A) forem gerados na pasta <code class="font-mono text-emerald-300">staging/</code>, eles aparecerão aqui para comparação Lado a Lado (Diff A/B).
          <br/>Os artefatos não-visuais (<code class="font-mono text-cyan-300">flashcards.md</code>, <code class="font-mono text-cyan-300">quiz.md</code>, <code class="font-mono text-cyan-300">mapa-mental.json</code> e <code class="font-mono text-cyan-300">relatorio.md</code>) são salvos diretamente sem precisar de revisão!
        </p>
      </div>
    `;
    return;
  }

  bodyEl.innerHTML = `
    ${resumoFilaHtml}
    <div class="space-y-5">
      ${itensRevisao.map(job => renderCardRevisaoDiffHtml(job)).join("\n")}
    </div>
  `;
}

// ==============================================================================
// 📦 MODAL DE GERAÇÃO / REGERAÇÃO EM LOTE (MULTI-SELEÇÃO: SEMESTRES, MATÉRIAS E TIPOS)
// ==============================================================================
const _loteState = {
  materiasSelecionadas: new Set(),
  tiposSelecionados: new Set(STUDIO_ARTIFACT_TYPES.map(t => t.id)),
  filtroBuscaMateria: "",
  modoAcao: "gerar_faltantes"
};

function normalizarBuscaTexto(txt) {
  return String(txt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function obterSemestresComDisciplinas() {
  const db = store.getState().db;
  return (db?.semestres || []).filter(sem => Array.isArray(sem?.disciplinas) && sem.disciplinas.length > 0);
}

/**
 * Retorna uma cópia da seleção atual do modal de Lote (útil para inspeção e testes).
 */
export function obterSelecaoAtualStudioLote() {
  const semestres = obterSemestresComDisciplinas();
  const semestresCompletos = semestres
    .filter(sem => sem.disciplinas.every(d => _loteState.materiasSelecionadas.has(d.id)))
    .map(sem => sem.id);

  return {
    semestresCompletos,
    materiaIds: Array.from(_loteState.materiasSelecionadas),
    tiposArtefato: Array.from(_loteState.tiposSelecionados),
    modoAcao: _loteState.modoAcao
  };
}

function renderizarConteudoModalLote() {
  if (typeof document === "undefined") return;
  const semestres = obterSemestresComDisciplinas();
  const todasDisciplinas = obterTodasDisciplinas(store.getState().db);
  const totalMat = todasDisciplinas.length;
  const qtdMatSel = _loteState.materiasSelecionadas.size;
  const qtdTiposSel = _loteState.tiposSelecionados.size;

  // 1. Contador de matérias
  const badgeMat = document.getElementById("studio-lote-badge-materias");
  if (badgeMat) {
    badgeMat.textContent = `${qtdMatSel} / ${totalMat} selecionada(s)`;
    badgeMat.className = qtdMatSel > 0
      ? "px-2 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-500/40 text-indigo-200 font-mono text-[10px]"
      : "px-2 py-0.5 rounded-md bg-rose-500/15 border border-rose-500/35 text-rose-300 font-mono text-[10px]";
  }

  // 2. Pílulas de Semestre (multi-seleção)
  const semGrid = document.getElementById("studio-lote-semestres-grid");
  if (semGrid) {
    if (semestres.length === 0) {
      semGrid.innerHTML = `<span class="text-[11px] font-mono text-notion-muted">Nenhum semestre encontrado no banco.</span>`;
    } else {
      semGrid.innerHTML = semestres.map(sem => {
        const discs = sem.disciplinas || [];
        const selNoSem = discs.filter(d => _loteState.materiasSelecionadas.has(d.id)).length;
        const tudo = discs.length > 0 && selNoSem === discs.length;
        const parcial = selNoSem > 0 && selNoSem < discs.length;

        const cls = tudo
          ? "bg-indigo-600/35 border-indigo-400 text-white shadow-sm"
          : parcial
            ? "bg-cyan-500/15 border-cyan-400/50 text-cyan-200"
            : "bg-notion-bg border-notion-border text-notion-muted hover:text-white hover:border-indigo-500/40";
        const iconeEstado = tudo ? "☑️" : parcial ? "◐" : "☐";

        return `
          <button
            type="button"
            data-lote-semestre="${escapeHtml(sem.id)}"
            class="px-2.5 py-1.5 rounded-xl border font-mono text-[11px] cursor-pointer transition-all inline-flex items-center gap-1.5 ${cls}"
            title="Clique para marcar ou desmarcar todas as matérias de ${escapeHtml(sem.nome)}"
          >
            <span>${iconeEstado}</span>
            <span class="font-semibold">${escapeHtml(sem.nome)}</span>
            <span class="text-[10px] opacity-80">(${selNoSem}/${discs.length})</span>
          </button>
        `;
      }).join("");
    }
  }

  // 3. Lista de Matérias agrupada por Semestre (com filtro de busca)
  const matLista = document.getElementById("studio-lote-materias-lista");
  if (matLista) {
    const termo = normalizarBuscaTexto(_loteState.filtroBuscaMateria);
    const blocosHtml = [];

    for (const sem of semestres) {
      const semMatch = termo && normalizarBuscaTexto(sem.nome).includes(termo);
      const discsFiltradas = (sem.disciplinas || []).filter(d => {
        if (!termo || semMatch) return true;
        return normalizarBuscaTexto(d.nome).includes(termo);
      });
      if (discsFiltradas.length === 0) continue;

      const totalNoSem = sem.disciplinas.length;
      const selNoSem = sem.disciplinas.filter(d => _loteState.materiasSelecionadas.has(d.id)).length;
      const tudoNoSem = totalNoSem > 0 && selNoSem === totalNoSem;

      blocosHtml.push(`
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2 px-1 pt-1 sticky top-0 bg-notion-bg/95 backdrop-blur-sm z-10 border-b border-white/5 pb-1">
            <span class="font-mono text-[10px] uppercase tracking-wider text-indigo-300 font-bold">
              📚 ${escapeHtml(sem.nome)} <span class="text-notion-muted font-normal">(${selNoSem}/${totalNoSem})</span>
            </span>
            <button
              type="button"
              data-lote-semestre="${escapeHtml(sem.id)}"
              class="text-[10px] font-mono text-indigo-300 hover:text-white underline cursor-pointer"
            >
              ${tudoNoSem ? "Desmarcar semestre" : "Marcar semestre"}
            </button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            ${discsFiltradas.map(d => {
              const marcada = _loteState.materiasSelecionadas.has(d.id);
              const qtdAulas = (d.aulas || []).filter(a => !String(a.id).endsWith("-materiais-gerais")).length;
              const cardCls = marcada
                ? "bg-indigo-500/20 border-indigo-400/60 text-white"
                : "bg-notion-card/60 border-notion-border/70 text-notion-muted hover:text-white hover:border-white/25";
              return `
                <button
                  type="button"
                  data-lote-materia="${escapeHtml(d.id)}"
                  class="w-full text-left px-2.5 py-2 rounded-xl border transition-all cursor-pointer flex items-center gap-2 ${cardCls}"
                >
                  <span class="shrink-0 text-xs">${marcada ? "☑️" : "☐"}</span>
                  <span class="shrink-0">${escapeHtml(d.icone || "📘")}</span>
                  <span class="truncate flex-1 font-mono text-[11px]">${escapeHtml(d.nome)}</span>
                  <span class="shrink-0 text-[10px] font-mono opacity-70">${qtdAulas}a</span>
                </button>
              `;
            }).join("")}
          </div>
        </div>
      `);
    }

    matLista.innerHTML = blocosHtml.length > 0
      ? blocosHtml.join("")
      : `<div class="p-4 text-center font-mono text-[11px] text-notion-muted">Nenhuma matéria encontrada para "${escapeHtml(_loteState.filtroBuscaMateria)}".</div>`;
  }

  // 4. Contador e grade de Tipos de Artefato (multi-seleção)
  const badgeTipos = document.getElementById("studio-lote-badge-tipos");
  if (badgeTipos) {
    badgeTipos.textContent = `${qtdTiposSel} / ${STUDIO_ARTIFACT_TYPES.length} selecionado(s)`;
    badgeTipos.className = qtdTiposSel > 0
      ? "px-2 py-0.5 rounded-md bg-purple-500/20 border border-purple-500/40 text-purple-200 font-mono text-[10px]"
      : "px-2 py-0.5 rounded-md bg-rose-500/15 border border-rose-500/35 text-rose-300 font-mono text-[10px]";
  }

  const tiposGrid = document.getElementById("studio-lote-tipos-grid");
  if (tiposGrid) {
    const tiposOrdenados = ORDEM_EXECUCAO_ARTEFATOS_STUDIO
      .map(id => MAPA_TIPOS_STUDIO[id])
      .filter(Boolean);
    tiposGrid.innerHTML = tiposOrdenados.map((t, idx) => {
      const marcado = _loteState.tiposSelecionados.has(t.id);
      const cls = marcado
        ? "bg-purple-500/20 border-purple-400/60 text-white shadow-sm"
        : "bg-notion-bg border-notion-border text-notion-muted hover:text-white hover:border-purple-500/40";
      const pillDestino = !t.requerRevisao
        ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[9px] font-mono shrink-0">⚡ Auto</span>`
        : `<span class="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[9px] font-mono shrink-0">👁️ Diff</span>`;
      return `
        <button
          type="button"
          data-lote-tipo="${escapeHtml(t.id)}"
          class="w-full text-left px-3 py-2 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 ${cls}"
        >
          <span class="flex items-center gap-2 min-w-0">
            <span class="shrink-0">${marcado ? "☑️" : "☐"}</span>
            <span class="shrink-0 text-[10px] font-mono opacity-60">${idx + 1}º</span>
            <span class="shrink-0">${t.icone}</span>
            <span class="truncate font-mono text-[11px] font-semibold">${escapeHtml(t.labelCompleto)}</span>
          </span>
          ${pillDestino}
        </button>
      `;
    }).join("");
  }

  // 5. Resumo / Previsão ao vivo de quantas tarefas entrarão na fila
  const previewEl = document.getElementById("studio-lote-resumo-preview");
  const btnConfirmar = document.getElementById("studio-lote-btn-confirmar");
  const sim = simularLoteStudio({
    materiaIds: Array.from(_loteState.materiasSelecionadas),
    tiposArtefato: Array.from(_loteState.tiposSelecionados),
    modoAcao: _loteState.modoAcao
  });

  if (previewEl) {
    if (qtdMatSel === 0 || qtdTiposSel === 0) {
      previewEl.className = "p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 font-mono text-[11px]";
      previewEl.innerHTML = `⚠️ Selecione pelo menos <strong>1 semestre/matéria</strong> e <strong>1 tipo de artefato</strong> para calcular o lote.`;
    } else if (sim.totalTarefas === 0) {
      previewEl.className = "p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 font-mono text-[11px]";
      previewEl.innerHTML = `ℹ️ Nenhuma tarefa pendente para essa combinação (${sim.totalMaterias} matéria(s) • ${sim.totalTipos} tipo(s) no modo selecionado).`;
    } else {
      const detalhes = [];
      if (sim.totalGerar > 0) detalhes.push(`➕ ${sim.totalGerar} gerar`);
      if (sim.totalRegerar > 0) detalhes.push(`🔄 ${sim.totalRegerar} regerar`);
      previewEl.className = "p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 font-mono text-[11px] flex items-center justify-between flex-wrap gap-2";
      previewEl.innerHTML = `
        <span>📊 Previsão do Lote: <strong class="text-white">${sim.totalTarefas} tarefa(s)</strong> (${sim.totalMaterias} matéria(s) • ${sim.totalTipos} tipo(s))</span>
        <span class="text-[10px] opacity-90">${detalhes.join(" • ")}</span>
      `;
    }
  }

  if (btnConfirmar) {
    const podeDisparar = qtdMatSel > 0 && qtdTiposSel > 0 && sim.totalTarefas > 0;
    btnConfirmar.disabled = !podeDisparar;
    btnConfirmar.className = podeDisparar
      ? "px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-mono font-bold shadow-lg cursor-pointer flex items-center gap-2 transition-colors"
      : "px-5 py-2.5 rounded-xl bg-indigo-600/30 text-white/50 font-mono font-bold cursor-not-allowed flex items-center gap-2";
    btnConfirmar.innerHTML = `<span>🚀 Enfileirar Lote Agora (${sim.totalTarefas})</span>`;
  }
}

function handleCliqueModalLote(ev) {
  const btnAcao = ev.target.closest?.("[data-lote-action]");
  if (btnAcao) {
    const acao = btnAcao.getAttribute("data-lote-action");
    if (acao === "mat-todas") {
      const todas = obterTodasDisciplinas(store.getState().db);
      _loteState.materiasSelecionadas = new Set(todas.map(d => d.id));
    } else if (acao === "mat-nenhuma") {
      _loteState.materiasSelecionadas.clear();
    } else if (acao === "tipo-todos") {
      _loteState.tiposSelecionados = new Set(STUDIO_ARTIFACT_TYPES.map(t => t.id));
    } else if (acao === "tipo-rapidos") {
      _loteState.tiposSelecionados = new Set(STUDIO_ARTIFACT_TYPES.filter(t => !t.requerRevisao).map(t => t.id));
    } else if (acao === "tipo-visuais") {
      _loteState.tiposSelecionados = new Set(STUDIO_ARTIFACT_TYPES.filter(t => t.requerRevisao).map(t => t.id));
    } else if (acao === "tipo-nenhum") {
      _loteState.tiposSelecionados.clear();
    }
    renderizarConteudoModalLote();
    return;
  }

  const btnSem = ev.target.closest?.("[data-lote-semestre]");
  if (btnSem) {
    const semId = btnSem.getAttribute("data-lote-semestre");
    const sem = obterSemestresComDisciplinas().find(s => s.id === semId);
    if (sem) {
      const idsSem = sem.disciplinas.map(d => d.id);
      const todosMarcados = idsSem.length > 0 && idsSem.every(id => _loteState.materiasSelecionadas.has(id));
      if (todosMarcados) {
        idsSem.forEach(id => _loteState.materiasSelecionadas.delete(id));
      } else {
        idsSem.forEach(id => _loteState.materiasSelecionadas.add(id));
      }
      renderizarConteudoModalLote();
    }
    return;
  }

  const btnMat = ev.target.closest?.("[data-lote-materia]");
  if (btnMat) {
    const discId = btnMat.getAttribute("data-lote-materia");
    if (discId) {
      if (_loteState.materiasSelecionadas.has(discId)) {
        _loteState.materiasSelecionadas.delete(discId);
      } else {
        _loteState.materiasSelecionadas.add(discId);
      }
      renderizarConteudoModalLote();
    }
    return;
  }

  const btnTipo = ev.target.closest?.("[data-lote-tipo]");
  if (btnTipo) {
    const tipoId = btnTipo.getAttribute("data-lote-tipo");
    if (tipoId) {
      if (_loteState.tiposSelecionados.has(tipoId)) {
        _loteState.tiposSelecionados.delete(tipoId);
      } else {
        _loteState.tiposSelecionados.add(tipoId);
      }
      renderizarConteudoModalLote();
    }
  }
}

function ensureModalLoteDOM() {
  let modal = document.getElementById("modal-studio-lote");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "modal-studio-lote";
  modal.className = "fixed inset-0 bg-black/85 backdrop-blur-md z-[115] hidden items-center justify-center p-3 sm:p-6";
  modal.innerHTML = `
    <div class="bg-notion-sidebar w-full max-w-3xl rounded-2xl shadow-2xl border border-notion-border overflow-hidden flex flex-col max-h-[92vh]">
      <div class="p-4 sm:p-5 border-b border-notion-border bg-gradient-to-r from-indigo-950/50 via-notion-sidebar to-purple-950/40 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-xl shrink-0">
            📦
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Gerar / Regerar Artefatos em Lote</h3>
            <p class="text-[11px] text-notion-muted">Selecione múltiplos semestres, matérias e tipos de artefato para enfileirar de uma vez</p>
          </div>
        </div>
        <button type="button" onclick="window.StudyOS?.fecharModalStudioLote()" class="p-1.5 rounded-lg hover:bg-notion-hover text-notion-muted hover:text-white transition-colors cursor-pointer">✕</button>
      </div>

      <div class="p-4 sm:p-5 overflow-y-auto space-y-5 text-xs flex-1">
        <!-- 1. Semestres e Matérias (Múltipla Escolha) -->
        <div class="space-y-2.5">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap">
              <label class="font-semibold text-white">1. Selecione Semestres e/ou Matérias:</label>
              <span id="studio-lote-badge-materias" class="px-2 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-500/40 text-indigo-200 font-mono text-[10px]">0 selecionadas</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button type="button" data-lote-action="mat-todas" class="px-2.5 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/30 border border-indigo-500/35 text-indigo-200 font-mono text-[10px] cursor-pointer transition-colors">
                🌐 Todas
              </button>
              <button type="button" data-lote-action="mat-nenhuma" class="px-2.5 py-1 rounded-lg bg-notion-card hover:bg-notion-hover border border-notion-border text-notion-muted hover:text-white font-mono text-[10px] cursor-pointer transition-colors">
                🧹 Limpar
              </button>
            </div>
          </div>

          <div class="space-y-1.5">
            <div class="text-[10px] font-mono uppercase tracking-wider text-notion-muted">Atalho por Semestre (clique para marcar/desmarcar vários):</div>
            <div id="studio-lote-semestres-grid" class="flex flex-wrap gap-1.5"></div>
          </div>

          <div class="space-y-2">
            <input
              id="studio-lote-busca-materia"
              type="text"
              placeholder="🔍 Filtrar matérias por nome ou semestre..."
              class="w-full px-3 py-2 rounded-xl bg-notion-bg border border-notion-border text-white placeholder-notion-muted font-mono text-xs focus:outline-none focus:border-indigo-500"
            />
            <div id="studio-lote-materias-lista" class="max-h-48 overflow-y-auto p-2.5 rounded-xl bg-notion-bg border border-notion-border space-y-3"></div>
          </div>
        </div>

        <!-- 2. Tipos de Artefato (Múltipla Escolha) -->
        <div class="space-y-2.5">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap">
              <label class="font-semibold text-white">2. Selecione os Tipos de Artefato:</label>
              <span id="studio-lote-badge-tipos" class="px-2 py-0.5 rounded-md bg-purple-500/20 border border-purple-500/40 text-purple-200 font-mono text-[10px]">8 / 8</span>
            </div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <button type="button" data-lote-action="tipo-todos" class="px-2.5 py-1 rounded-lg bg-purple-500/15 hover:bg-purple-500/30 border border-purple-500/35 text-purple-200 font-mono text-[10px] cursor-pointer transition-colors">
                ⚡ Todos (8)
              </button>
              <button type="button" data-lote-action="tipo-rapidos" class="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 border border-emerald-500/35 text-emerald-200 font-mono text-[10px] cursor-pointer transition-colors">
                🚀 Só Rápidos / Auto (4)
              </button>
              <button type="button" data-lote-action="tipo-visuais" class="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/35 text-amber-200 font-mono text-[10px] cursor-pointer transition-colors">
                👁️ Só Visuais (4)
              </button>
              <button type="button" data-lote-action="tipo-nenhum" class="px-2.5 py-1 rounded-lg bg-notion-card hover:bg-notion-hover border border-notion-border text-notion-muted hover:text-white font-mono text-[10px] cursor-pointer transition-colors">
                🧹 Limpar
              </button>
            </div>
          </div>

          <div id="studio-lote-tipos-grid" class="grid grid-cols-1 sm:grid-cols-2 gap-2"></div>
        </div>

        <!-- 3. Modo da Operação -->
        <div class="space-y-1.5">
          <label class="font-semibold text-white block">3. Modo da Operação em Lote:</label>
          <select id="studio-lote-select-modo" class="w-full px-3 py-2 rounded-xl bg-notion-bg border border-notion-border text-white font-mono text-xs focus:outline-none focus:border-indigo-500">
            <option value="gerar_faltantes">➕ Gerar Apenas Artefatos Faltantes (Recomendado)</option>
            <option value="todos">⚡ Gerar Faltantes + Regerar Existentes (Processar Tudo)</option>
            <option value="regerar_existentes">🔄 Regerar Apenas Artefatos Já Existentes (Atualizar padrão visual/modelo)</option>
          </select>
        </div>

        <!-- Resumo em Tempo Real -->
        <div id="studio-lote-resumo-preview" class="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 font-mono text-[11px]"></div>
      </div>

      <div class="p-4 border-t border-notion-border bg-notion-bg/60 flex items-center justify-between gap-3 text-xs">
        <button type="button" onclick="window.StudyOS?.fecharModalStudioLote()" class="px-4 py-2 rounded-xl bg-notion-card hover:bg-notion-hover border border-notion-border text-notion-muted hover:text-white cursor-pointer">
          Cancelar
        </button>
        <button id="studio-lote-btn-confirmar" type="button" onclick="window.StudyOS?.confirmarDisparoStudioLote()" class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-mono font-bold shadow-lg cursor-pointer flex items-center gap-2">
          <span>🚀 Enfileirar Lote Agora</span>
        </button>
      </div>
    </div>
  `;

  modal.addEventListener("click", handleCliqueModalLote);

  const inputBusca = modal.querySelector("#studio-lote-busca-materia");
  if (inputBusca) {
    inputBusca.addEventListener("input", (ev) => {
      _loteState.filtroBuscaMateria = ev.target?.value || "";
      renderizarConteudoModalLote();
    });
  }

  const selectModo = modal.querySelector("#studio-lote-select-modo");
  if (selectModo) {
    selectModo.addEventListener("change", (ev) => {
      _loteState.modoAcao = ev.target?.value || "gerar_faltantes";
      renderizarConteudoModalLote();
    });
  }

  document.body.appendChild(modal);
  return modal;
}

export function abrirModalStudioLote(discIdPreSelecionada = "") {
  if (typeof document === "undefined") return;
  const modal = ensureModalLoteDOM();
  const todas = obterTodasDisciplinas(store.getState().db);

  _loteState.filtroBuscaMateria = "";
  _loteState.tiposSelecionados = new Set(STUDIO_ARTIFACT_TYPES.map(t => t.id));
  if (discIdPreSelecionada) {
    _loteState.materiasSelecionadas = new Set([discIdPreSelecionada]);
  } else {
    _loteState.materiasSelecionadas = new Set(todas.map(d => d.id));
  }

  const inputBusca = document.getElementById("studio-lote-busca-materia");
  if (inputBusca) inputBusca.value = "";
  const selectModo = document.getElementById("studio-lote-select-modo");
  if (selectModo) selectModo.value = _loteState.modoAcao;

  renderizarConteudoModalLote();

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

export function fecharModalStudioLote() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-studio-lote");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

export function confirmarDisparoStudioLote() {
  if (typeof document === "undefined") return;
  const modoVal = document.getElementById("studio-lote-select-modo")?.value || _loteState.modoAcao || "gerar_faltantes";
  _loteState.modoAcao = modoVal;

  const materiaIds = Array.from(_loteState.materiasSelecionadas);
  const tiposArtefato = Array.from(_loteState.tiposSelecionados);

  if (materiaIds.length === 0 || tiposArtefato.length === 0) {
    mostrarToast(
      "Seleção Incompleta ⚠️",
      "Selecione pelo menos 1 semestre/matéria e 1 tipo de artefato antes de enfileirar.",
      "warning"
    );
    return;
  }

  const jobs = dispararLoteStudio({
    materiaIds,
    tiposArtefato,
    modoAcao: modoVal
  });

  fecharModalStudioLote();
  if (document.getElementById("modal-studio-revisao")?.classList.contains("flex")) {
    renderCorpoModalStudioRevisao();
  }

  if (jobs.length === 0) {
    mostrarToast(
      "Nenhuma Tarefa Nova ℹ️",
      "Nenhum artefato precisou ser enfileirado para a combinação e modo escolhidos.",
      "info"
    );
    return;
  }

  mostrarToast(
    "Lote Enfileirado no Studio! 📦",
    `${jobs.length} tarefa(s) (${materiaIds.length} matéria(s) • ${tiposArtefato.length} tipo(s)) adicionada(s) à fila instantaneamente.`,
    "success"
  );
}

// ==============================================================================
// 📑 MODAL DE RELATÓRIO E EDIÇÃO DE FONTES DO CADERNO (NOTEBOOKLM)
// ==============================================================================
function ensureModalFontesDOM() {
  let modal = document.getElementById("modal-studio-fontes");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "modal-studio-fontes";
  modal.className = "fixed inset-0 bg-black/85 backdrop-blur-md z-[115] hidden items-center justify-center p-3 sm:p-6";
  modal.innerHTML = `
    <div class="bg-notion-sidebar w-full max-w-3xl rounded-2xl shadow-2xl border border-notion-border overflow-hidden flex flex-col max-h-[92vh]">
      <div class="p-4 sm:p-5 border-b border-notion-border bg-gradient-to-r from-cyan-950/50 via-notion-sidebar to-indigo-950/40 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-xl shrink-0">
            📑
          </div>
          <div>
            <h3 id="studio-fontes-title" class="text-base font-bold text-white">Relatório de Fontes do Caderno (NotebookLM)</h3>
            <p id="studio-fontes-subtitle" class="text-[11px] font-mono text-notion-muted">Auditoria sob demanda via notebooklm-py</p>
          </div>
        </div>
        <button type="button" onclick="window.StudyOS?.fecharModalFontesNotebook()" class="p-1.5 rounded-lg hover:bg-notion-hover text-notion-muted hover:text-white transition-colors cursor-pointer">✕</button>
      </div>

      <div id="studio-fontes-body" class="p-5 overflow-y-auto space-y-4 text-xs flex-1">
      </div>

      <div class="p-4 border-t border-notion-border bg-notion-bg/60 flex items-center justify-between gap-3 text-xs">
        <button type="button" onclick="window.StudyOS?.fecharModalFontesNotebook()" class="px-4 py-2 rounded-xl bg-notion-card hover:bg-notion-hover border border-notion-border text-notion-muted hover:text-white cursor-pointer">
          Fechar
        </button>
        <button id="btn-salvar-relatorio-fontes-db" type="button" class="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-mono font-bold shadow-md cursor-pointer">
          💾 Salvar Relatório de Fontes no DB
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

export async function abrirModalFontesNotebook(discId, aulaId) {
  if (typeof document === "undefined") return;
  const disc = buscarDisciplinaPorId(discId);
  const aula = (disc?.aulas || []).find(a => a.id === aulaId);
  if (!aula) return;

  const modal = ensureModalFontesDOM();
  const titleEl = document.getElementById("studio-fontes-title");
  const subEl = document.getElementById("studio-fontes-subtitle");
  const bodyEl = document.getElementById("studio-fontes-body");
  const btnSalvar = document.getElementById("btn-salvar-relatorio-fontes-db");

  if (titleEl) titleEl.textContent = `📑 Fontes do Caderno — ${disc.nome} (${aula.nome})`;
  if (subEl) subEl.textContent = aula.linkNotebookLLM || "Sem link do NotebookLM cadastrado";
  if (bodyEl) {
    bodyEl.innerHTML = `<div class="p-8 text-center font-mono text-notion-muted">⏳ Consultando fontes do caderno via Studio Worker (notebooklm-py)...</div>`;
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");

  try {
    const relatorio = await consultarRelatorioFontesNotebook({
      notebookUrl: aula.linkNotebookLLM || "",
      materiaId: disc.id,
      aulaId: aula.id
    });

    const fontes = Array.isArray(relatorio.fontes) ? relatorio.fontes : [];
    const faltando = relatorio.diagnostico?.faltando_no_notebook || [];

    if (btnSalvar) {
      btnSalvar.onclick = async () => {
        try {
          await fetch(`${getStudioWorkerUrl()}/api/studio/fontes/salvar-db`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              materia_id: disc.id,
              aula_id: aula.id,
              pasta_aula: aula.local || "",
              notebook_url: aula.linkNotebookLLM || "",
              fontes,
              diagnostico: relatorio.diagnostico || {}
            })
          });
          aula.relatorioFontesNotebook = fontes;
          mostrarToast("Fontes Salvas no DB! 💾", `Relatório de fontes de ${aula.nome} gravado no db.json.`, "success");
        } catch (err) {
          mostrarToast("Erro ao salvar no DB", err.message, "error");
        }
      };
    }

    if (bodyEl) {
      bodyEl.innerHTML = `
        ${relatorio.aviso_sdk ? `
          <div class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 font-mono text-[11px]">
            ⚠️ ${escapeHtml(relatorio.aviso_sdk)}
          </div>
        ` : ""}

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono">
          <div class="p-3 rounded-xl bg-notion-card border border-notion-border">
            <div class="text-[10px] text-notion-muted uppercase">Fontes no Caderno</div>
            <div class="text-lg font-bold text-cyan-300">${fontes.length}</div>
          </div>
          <div class="p-3 rounded-xl bg-notion-card border border-notion-border">
            <div class="text-[10px] text-notion-muted uppercase">Arquivos da Aula (DB)</div>
            <div class="text-lg font-bold text-white">${(relatorio.arquivos_aula_db || []).length}</div>
          </div>
          <div class="p-3 rounded-xl bg-notion-card border border-notion-border">
            <div class="text-[10px] text-notion-muted uppercase">Faltando no Caderno</div>
            <div class="text-lg font-bold ${faltando.length > 0 ? "text-rose-400" : "text-emerald-400"}">${faltando.length}</div>
          </div>
        </div>

        ${faltando.length > 0 ? `
          <div class="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-1.5">
            <div class="font-mono font-bold text-rose-300">🚨 Diagnóstico: Arquivos da aula que ainda não constam no caderno:</div>
            <ul class="list-disc list-inside text-[11px] font-mono text-rose-200 space-y-0.5">
              ${faltando.map(nome => `<li>${escapeHtml(nome)}</li>`).join("")}
            </ul>
          </div>
        ` : `
          <div class="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono text-[11px]">
            ✅ Todos os arquivos principais da aula estão sincronizados com o caderno!
          </div>
        `}

        <div class="space-y-2">
          <div class="font-mono font-bold text-white uppercase text-[11px]">Fontes Listadas no Caderno NotebookLM:</div>
          ${fontes.length === 0 ? `
            <div class="p-4 rounded-xl bg-black/40 border border-white/10 text-notion-muted font-mono text-center">
              Nenhuma fonte retornada pelo caderno.
            </div>
          ` : `
            <div class="space-y-1.5">
              ${fontes.map(f => `
                <div class="p-2.5 rounded-xl bg-notion-card border border-notion-border flex items-center justify-between gap-2 font-mono">
                  <div class="truncate">
                    <span class="text-cyan-300 font-semibold">${escapeHtml(f.titulo)}</span>
                    <span class="text-[10px] text-notion-muted ml-2">(${escapeHtml(f.tipo)} • ${escapeHtml(f.status)})</span>
                  </div>
                </div>
              `).join("")}
            </div>
          `}
        </div>
      `;
    }
  } catch (err) {
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div class="p-5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 space-y-2 font-mono">
          <div class="font-bold">⚠️ Studio Worker Offline (http://127.0.0.1:8090)</div>
          <p class="text-[11px] text-notion-muted">
            Para consultar e editar as fontes do NotebookLM ao vivo, inicie o worker no terminal com:
            <code class="text-white bg-black/50 px-2 py-0.5 rounded block mt-1">python studio_worker.py</code>
          </p>
        </div>
      `;
    }
  }
}

export function fecharModalFontesNotebook() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-studio-fontes");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}
