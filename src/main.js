/**
 * Study OS V2 - Main Entry Point
 * Ponto de entrada modular, desacoplado e ultraleve que inicializa o aplicativo,
 * orquestra o roteamento hash, gerencia o ciclo de vida de memória e
 * carrega modais pesados estritamente sob demanda via Dynamic Imports (import()).
 */

import { store, normalizarDb, obterTodasDisciplinas, buscarDisciplinaPorId, buscarRefDisciplina, calcularEstatisticasDb } from "./core/store.js";
import { router } from "./core/router.js";
import { renderSidebar } from "./components/Sidebar.js";
import { atualizarBreadcrumbs, atualizarTopbarStats } from "./components/Topbar.js";
import {
  renderDisciplineCardHtml,
  getStatusBadgeHtml,
  formatarTagPillHtml,
  getStatusAtividadeBadge,
  renderCardAulasNumerosHtml,
  renderCardAulaPillHtml,
  renderCardAtividadeItemHtml,
  ehTagRedundanteDePasta,
  ordenarTagsSemanticamente
} from "./components/DisciplineCard.js";
import { renderBarraSelectsMidiaAula, renderDisciplineLessons, aoAlternarToggleAula, montarConteudoInternoDaAula } from "./components/LessonAccordion.js";
import { carregarDbLocal, carregarDbFirebase, enviarFilaEdicaoMd } from "./services/api.js";
import {
  salvarDbCache,
  obterDbCache,
  limparDbCache,
  salvarBaseMediaPath,
  obterBaseMediaPath,
  salvarEdicaoMdCache,
  obterTemaPreferido,
  salvarTemaPreferido,
  aplicarTemaNoDocumento,
  alternarTema
} from "./services/storage.js";
import { indexarPastaLocal, revogarTodosBlobs, revogarBlobsDaAula } from "./services/mediaResolver.js";
import { desconectarMediaObserver, observarMidiasLazy } from "./utils/performance.js";
import { escapeHtml, mostrarToast, obterTituloAula } from "./utils/domHelpers.js";
import { obterHtmlMarkdownParseado } from "./utils/markdownParser.js";
import { PRESETS_MIDIA, OPCOES_MIDIA_AULA } from "./core/constants.js";
import { 
  exigirAdmin, 
  abrirModalSenhaAdmin, 
  fecharModalSenhaAdmin, 
  submeterSenhaAdmin, 
  desautenticarAdmin, 
  isAdminAutenticado, 
  atualizarUiModoAdmin 
} from "./services/auth.js";

// ==============================================================================
// 🚀 DYNAMIC IMPORT LOADERS PARA MODAIS PESADOS (CODE SPLITTING / SRP ESTRITO)
// ==============================================================================

export const Modals = {
  loadCinema: () => import("./modals/ImmersiveCinemaModal.js"),
  loadAtividade: () => import("./modals/AtividadeModal.js"),
  loadDisciplineMeta: () => import("./modals/DisciplineMetaModal.js"),
  loadDataAula: () => import("./modals/DataAulaModal.js"),
  loadImportReport: () => import("./modals/ImportReportModal.js"),
  loadArquivosReferencias: () => import("./modals/ArquivosReferenciasModal.js")
};

// ==============================================================================
// 🌐 VIEW CONTROLLERS (HOME & DISCIPLINA)
// ==============================================================================

export function renderHomeView() {
  const state = store.getState();
  const todas = obterTodasDisciplinas(state.db);
  const stats = calcularEstatisticasDb(state.db);

  atualizarTopbarStats(stats.disciplinas, stats.pdfsSemOcr);
  atualizarBreadcrumbs("home");

  const widget = document.getElementById("home-progress-widget");
  if (widget) {
    widget.innerHTML = `
      <button onclick="window.StudyOS?.filtrarPorStatus('Aprovado')" class="px-2.5 py-1 rounded-lg hover:bg-notion-hover transition-colors text-left cursor-pointer">
        <div class="text-[10px] text-notion-muted">Aprovadas</div>
        <div class="text-sm font-bold text-emerald-400 font-mono">${stats.porStatus.aprovado}</div>
      </button>
      <div class="h-6 w-px bg-notion-border"></div>
      <button onclick="window.StudyOS?.filtrarPorStatus('Em andamento')" class="px-2.5 py-1 rounded-lg hover:bg-notion-hover transition-colors text-left cursor-pointer">
        <div class="text-[10px] text-notion-muted">Andamento / Cursos</div>
        <div class="text-sm font-bold text-blue-400 font-mono">${stats.porStatus.andamento}</div>
      </button>
      <div class="h-6 w-px bg-notion-border"></div>
      <div class="px-2.5 py-1 text-left">
        <div class="text-[10px] text-notion-muted">PDFs Sem OCR</div>
        <div class="text-sm font-bold text-amber-400 font-mono">${stats.pdfsSemOcr}</div>
      </div>
    `;
  }

  const semContainer = document.getElementById("semester-filters");
  if (semContainer) {
    const botoesSem = [
      `<button onclick="window.StudyOS?.setFiltroSemestre('todos')" class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${state.filtroSemestreAtivo === 'todos' ? 'bg-indigo-600 text-white' : 'bg-notion-card text-notion-muted hover:text-notion-text border border-notion-border'}">Todas (${todas.length})</button>`
    ];
    (state.db?.semestres || []).forEach(sem => {
      const ativo = state.filtroSemestreAtivo === sem.id;
      botoesSem.push(`
        <button onclick="window.StudyOS?.setFiltroSemestre('${sem.id}')" class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${ativo ? 'bg-indigo-600 text-white' : 'bg-notion-card text-notion-muted hover:text-notion-text border border-notion-border'}">
          ${escapeHtml(sem.nome)} <span class="opacity-70 font-mono text-[10px]">(${(sem.disciplinas || []).length})</span>
        </button>
      `);
    });
    semContainer.innerHTML = botoesSem.join("");
  }

  const statusContainer = document.getElementById("status-filters");
  if (statusContainer) {
    const opcoesStatus = [
      { id: "todos", label: "Todos os Status", icone: "📋" },
      { id: "Aprovado", label: `Aprovado (${stats.porStatus.aprovado})`, icone: "🟢" },
      { id: "Em andamento", label: `Em andamento (${stats.porStatus.andamento})`, icone: "🔵" },
      { id: "DP", label: `DP (${stats.porStatus.dp})`, icone: "🔴" }
    ];
    statusContainer.innerHTML = opcoesStatus.map(st => {
      const ativo = state.filtroStatusAtivo === st.id;
      return `
        <button onclick="window.StudyOS?.setFiltroStatus('${st.id}')" class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${ativo ? 'bg-indigo-600 text-white' : 'bg-notion-card text-notion-muted hover:text-notion-text border border-notion-border'}">
          <span>${st.icone}</span>
          <span>${st.label}</span>
        </button>
      `;
    }).join("");
  }

  const tagContainer = document.getElementById("tag-pills-container");
  if (tagContainer) {
    const tagsUnicas = new Set();
    todas.forEach(d => {
      (d.TAGS || []).forEach(t => {
        if (!ehTagRedundanteDePasta(t)) {
          tagsUnicas.add(t);
        }
      });
    });
    const tagsOrdenadas = ordenarTagsSemanticamente(Array.from(tagsUnicas));
    tagContainer.innerHTML = [
      `<button onclick="window.StudyOS?.filtrarPorTag('todas')" class="px-2 py-0.5 rounded-md text-[10px] font-mono border cursor-pointer ${state.filtroTagAtiva === 'todas' ? 'bg-indigo-600 text-white border-indigo-400' : 'bg-notion-card text-notion-muted border-notion-border hover:text-notion-text'}">Todas</button>`,
      ...tagsOrdenadas.map(t => formatarTagPillHtml(t, state.filtroTagAtiva, true))
    ].join("");
  }

  ["gallery", "table"].forEach(m => {
    const btn = document.getElementById(`view-btn-${m}`);
    if (btn) {
      if (state.databaseViewMode === m) {
        btn.className = "px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 bg-indigo-600 text-white shadow-xs cursor-pointer";
      } else {
        btn.className = "px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 text-notion-muted hover:text-notion-text cursor-pointer";
      }
    }
  });

  renderDisciplinesDatabase();
}

export function renderDisciplinesDatabase() {
  const grid = document.getElementById("disciplines-grid");
  const counter = document.getElementById("db-filtered-counter");
  const activeBar = document.getElementById("active-filters-bar");
  const activeChips = document.getElementById("active-filters-chips");
  if (!grid) return;

  const state = store.getState();
  const todas = obterTodasDisciplinas(state.db);
  const termo = state.filtroTextoInline.trim().toLowerCase();

  const filtradas = todas.filter(d => {
    if (state.filtroSemestreAtivo !== "todos" && d.semestreId !== state.filtroSemestreAtivo) return false;
    if (state.filtroStatusAtivo !== "todos" && d.status !== state.filtroStatusAtivo) return false;
    if (state.filtroTagAtiva !== "todas") {
      const temTag = (d.TAGS || []).some(t => t.toLowerCase() === state.filtroTagAtiva.toLowerCase());
      if (!temTag) return false;
    }
    if (termo) {
      const alvo = `${d.nome} ${d.prof} ${d.semestreNome} ${(d.TAGS || []).join(" ")}`.toLowerCase();
      if (!alvo.includes(termo)) return false;
    }
    return true;
  });

  if (counter) counter.textContent = `${filtradas.length} de ${todas.length} matérias`;

  const chips = [];
  if (state.filtroSemestreAtivo !== "todos") chips.push(`Pasta: ${state.filtroSemestreAtivo}`);
  if (state.filtroStatusAtivo !== "todos") chips.push(`Status: ${state.filtroStatusAtivo}`);
  if (state.filtroTagAtiva !== "todas") chips.push(`Tag: ${state.filtroTagAtiva}`);
  if (termo) chips.push(`Busca: "${state.filtroTextoInline}"`);

  if (activeBar && activeChips) {
    if (chips.length > 0) {
      activeBar.classList.remove("hidden");
      activeChips.innerHTML = chips.map(c => `<span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono text-[11px]">${escapeHtml(c)}</span>`).join("");
    } else {
      activeBar.classList.add("hidden");
    }
  }

  if (filtradas.length === 0) {
    grid.innerHTML = `
      <div class="p-12 rounded-2xl bg-notion-sidebar border border-notion-border text-center space-y-3">
        <div class="text-4xl">📂</div>
        <h3 class="text-base font-bold text-notion-text">Nenhuma matéria encontrada</h3>
        <p class="text-xs text-notion-muted max-w-md mx-auto">Importe seu arquivo <code class="font-mono text-indigo-300">db.json</code> na barra lateral esquerda ou limpe os filtros ativos.</p>
      </div>
    `;
    return;
  }

  if (state.databaseViewMode === "table") {
    grid.innerHTML = `
      <div class="overflow-x-auto rounded-2xl border border-notion-border bg-notion-sidebar">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-notion-border bg-notion-bg/60 text-notion-muted font-mono text-[11px] uppercase">
              <th class="py-3 px-4">Matéria / Curso</th>
              <th class="py-3 px-4">Pasta</th>
              <th class="py-3 px-4">Status</th>
              <th class="py-3 px-4">Professor</th>
              <th class="py-3 px-4">Tags</th>
              <th class="py-3 px-4">Atividades & Status</th>
              <th class="py-3 px-4 text-right">Controle de Aulas</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-notion-border/60">
            ${filtradas.map(d => `
              <tr onclick="window.location.hash='#/disciplina/${d.id}'" class="hover:bg-notion-hover cursor-pointer transition-colors">
                <td class="py-3 px-4 font-semibold text-notion-text flex items-center gap-2">
                  <span class="text-base">${d.icone || '📘'}</span>
                  <span>${escapeHtml(d.nome)}</span>
                </td>
                <td class="py-3 px-4 text-notion-muted font-mono text-[11px]">${escapeHtml(d.semestreNome)}</td>
                <td class="py-3 px-4">${getStatusBadgeHtml(d.status, true)}</td>
                <td class="py-3 px-4 text-notion-muted">${escapeHtml(d.prof)}</td>
                <td class="py-3 px-4"><div class="flex flex-wrap gap-1">${ordenarTagsSemanticamente((d.TAGS || []).filter(t => !ehTagRedundanteDePasta(t))).map(t => formatarTagPillHtml(t, state.filtroTagAtiva, true)).join("")}</div></td>
                <td class="py-3 px-4" onclick="event.stopPropagation()">
                  <div class="flex items-center gap-1 flex-wrap">
                    ${(d.atividades || []).map((a, i) => getStatusAtividadeBadge(a.status, true, `window.StudyOS?.abrirModalAtividade('${d.id}', ${i})`)).join("")}
                    ${(d.atividades || []).length === 0 ? '<span class="text-notion-muted text-[11px] font-mono">—</span>' : ''}
                  </div>
                </td>
                <td class="py-3 px-4 text-right" onclick="event.stopPropagation()">
                  <div class="flex items-center justify-end gap-1 flex-wrap">
                    ${renderCardAulasNumerosHtml(d)}
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
    return;
  }

  // Visão Galeria
  grid.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      ${filtradas.map(disc => renderDisciplineCardHtml(disc, state.filtroTagAtiva)).join("")}
    </div>
  `;
}

export function renderAtividadesDisciplina(disc) {
  const statusRollupEl = document.getElementById("disc-atividades-status");
  const notaFinalRollupEl = document.getElementById("disc-nota-final");
  const listEl = document.getElementById("disc-atividades-list");
  const badgeCountEl = document.getElementById("disc-atividades-badge-count");
  const btnNova = document.getElementById("btn-nova-atividade");

  if (!statusRollupEl || !notaFinalRollupEl || !listEl) return;

  const atividades = Array.isArray(disc?.atividades) ? disc.atividades : [];

  if (badgeCountEl) badgeCountEl.textContent = atividades.length;
  if (btnNova) {
    if (isAdminAutenticado()) {
      btnNova.classList.remove("hidden");
      btnNova.onclick = () => window.StudyOS?.abrirModalAtividade(disc.id, -1);
    } else {
      btnNova.classList.add("hidden");
    }
  }

  if (atividades.length === 0) {
    statusRollupEl.innerHTML = `<span class="text-notion-muted italic text-[11px]">Nenhuma atividade vinculada</span>`;
  } else {
    statusRollupEl.innerHTML = atividades.map((ativ, idx) => {
      const st = ativ.status || "A fazer";
      const sLower = st.toLowerCase();
      let cor = "bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/35";
      let dot = "bg-rose-400";
      if (sLower.includes("conclu")) {
        cor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/35";
        dot = "bg-emerald-400";
      } else if (sLower.includes("fazendo")) {
        cor = "bg-sky-500/20 text-sky-300 border-sky-500/40 hover:bg-sky-500/35";
        dot = "bg-sky-400";
      }

      return `
        <button
          type="button"
          onclick="window.StudyOS?.abrirModalAtividade('${disc.id}', ${idx})"
          title="Abrir detalhes da atividade '${escapeHtml(ativ.nome)}'"
          class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${cor} transition-all cursor-pointer shadow-xs"
        >
          <span class="w-1.5 h-1.5 rounded-full ${dot}"></span>
          <span class="font-semibold text-white/90 truncate max-w-[140px]">${escapeHtml(ativ.nome)}:</span>
          <span>${escapeHtml(st)}</span>
        </button>
      `;
    }).join("");
  }

  let somaObtida = 0;
  let somaMaxima = 0;
  atividades.forEach(a => {
    somaObtida += parseFloat(a.nota_obtida) || 0;
    somaMaxima += parseFloat(a.nota_maxima) || 0;
  });

  if (somaMaxima > 0) {
    const pctFinal = Math.round((somaObtida / somaMaxima) * 100);
    const corPct = pctFinal >= 70 ? "text-emerald-400" : (pctFinal >= 50 ? "text-amber-400" : "text-rose-400");
    notaFinalRollupEl.innerHTML = `
      <span class="inline-flex items-center gap-2 px-3 py-1 rounded-lg bg-indigo-500/15 border border-indigo-500/30 font-mono text-xs shadow-xs">
        <span class="text-amber-300">🏆</span>
        <strong class="text-white">${somaObtida.toFixed(1)} / ${somaMaxima.toFixed(1)}</strong>
        <span class="${corPct} font-bold">(${pctFinal}%)</span>
      </span>
    `;
  } else {
    notaFinalRollupEl.innerHTML = `<span class="text-notion-muted font-mono text-xs">— (Sem notas cadastradas)</span>`;
  }

  if (atividades.length === 0) {
    listEl.innerHTML = `
      <div class="p-6 rounded-xl bg-notion-bg/60 border border-notion-border text-center space-y-2">
        <p class="text-xs text-notion-muted">Nenhuma atividade valendo nota vinculada a esta matéria no Notion.</p>
        ${isAdminAutenticado() ? `
          <button onclick="window.StudyOS?.abrirModalAtividade('${disc.id}', -1)" class="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 hover:text-white border border-indigo-500/40 text-xs font-medium transition-all cursor-pointer">
            + Cadastrar Primeira Atividade
          </button>
        ` : ""}
      </div>
    `;
    return;
  }

  listEl.innerHTML = atividades.map((ativ, idx) => {
    const notaObt = parseFloat(ativ.nota_obtida) || 0;
    const notaMax = parseFloat(ativ.nota_maxima) || 0;
    const pct = notaMax > 0 ? Math.round((notaObt / notaMax) * 100) : 0;
    const pctTxt = notaMax > 0 ? `${pct}%` : "—";
    const corNota = pct >= 70 ? "text-emerald-400" : (pct >= 50 ? "text-amber-400" : "text-rose-400");

    return `
      <div class="p-3.5 sm:p-4 rounded-xl bg-notion-card hover:bg-notion-hover border border-notion-border hover:border-indigo-500/40 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm group">
        <div class="flex items-start gap-3 min-w-0">
          <span class="text-lg shrink-0 mt-0.5">📝</span>
          <div class="space-y-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/35 font-mono font-bold text-[10px]">
                ${escapeHtml(ativ.avaliacao || "A1")}
              </span>
              <span class="px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30 font-mono text-[10px]">
                ${escapeHtml(ativ.tipo || "Atividade")}
              </span>
              <h4 class="font-semibold text-sm text-notion-text hover:text-indigo-300 cursor-pointer transition-colors" onclick="window.StudyOS?.abrirModalAtividade('${disc.id}', ${idx})">
                ${escapeHtml(ativ.nome)}
              </h4>
            </div>
            <div class="flex items-center gap-3 text-[11px] text-notion-muted flex-wrap">
              <span class="flex items-center gap-1 font-mono">
                <span>📅</span>
                <span>${ativ.data ? escapeHtml(ativ.data) : "Sem data"}</span>
              </span>
              ${ativ.corpo_md ? `<span class="text-amber-400/80 font-mono text-[10px]">📄 Possui Anotações</span>` : ""}
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 self-end sm:self-center shrink-0">
          ${getStatusAtividadeBadge(ativ.status, true, `window.StudyOS?.abrirModalAtividade('${disc.id}', ${idx})`)}

          <div class="px-3 py-1 rounded-lg bg-notion-bg border border-notion-border flex items-center gap-1.5 font-mono text-xs">
            <span class="text-notion-muted">Nota:</span>
            <strong class="text-white">${notaObt} / ${notaMax}</strong>
            <span class="${corNota} font-bold text-[11px]">(${pctTxt})</span>
          </div>

          ${isAdminAutenticado() ? `
            <button
              type="button"
              onclick="window.StudyOS?.abrirModalAtividade('${disc.id}', ${idx})"
              class="px-3 py-1.5 rounded-lg bg-notion-sidebar hover:bg-indigo-600/30 border border-notion-border hover:border-indigo-500/50 text-notion-text hover:text-indigo-200 text-xs font-medium transition-all cursor-pointer"
            >
              ✏️ Editar
            </button>
          ` : `
            <span class="text-[11px] font-mono text-zinc-500 select-none">🔒 Leitura</span>
          `}
        </div>
      </div>
    `;
  }).join("");
}

export function renderDisciplineView(slug) {
  const disc = buscarDisciplinaPorId(slug);
  if (!disc) {
    router.navigate("#/");
    return;
  }

  // Prevenção de vazamento de memória: revoga blobs anteriores ao trocar de matéria
  revogarTodosBlobs();
  desconectarMediaObserver();
  store.getState().aulasAbertas.clear();

  atualizarBreadcrumbs("disciplina", {
    semestreNome: disc.semestreNome,
    icone: disc.icone,
    nome: disc.nome
  });

  const discIcon = document.getElementById("disc-icon");
  const discTitle = document.getElementById("disc-title");
  const discProf = document.getElementById("disc-prof");
  const discStatus = document.getElementById("disc-status");
  const discTags = document.getElementById("disc-tags");
  const discPath = document.getElementById("disc-path");
  const coverImg = document.getElementById("disc-cover-img");
  const btnDriveFolder = document.getElementById("disc-drive-folder-btn");
  const btnEditMeta = document.getElementById("btn-edit-disc-meta");

  if (discIcon) discIcon.textContent = disc.icone || "📘";
  if (discTitle) discTitle.textContent = disc.nome;
  if (discProf) discProf.textContent = disc.prof;
  if (discStatus) discStatus.innerHTML = getStatusBadgeHtml(disc.status, true);
  if (discTags) discTags.innerHTML = (disc.TAGS || []).map(t => formatarTagPillHtml(t, store.getState().filtroTagAtiva, true)).join("");
  if (discPath) discPath.textContent = disc.caminhoLocal || "";

  if (coverImg) {
    coverImg.src = disc.cover || "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1400&q=80";
  }

  if (btnDriveFolder) {
    if (disc.driveId) {
      btnDriveFolder.href = `https://drive.google.com/drive/folders/${disc.driveId}`;
      btnDriveFolder.classList.remove("hidden");
    } else {
      btnDriveFolder.classList.add("hidden");
    }
  }

  if (btnEditMeta) {
    if (isAdminAutenticado()) {
      btnEditMeta.classList.remove("hidden");
      btnEditMeta.onclick = () => window.StudyOS?.abrirModalEditarDisciplina(disc.id);
    } else {
      btnEditMeta.classList.add("hidden");
    }
  }

  renderAtividadesDisciplina(disc);
  renderBarraSelectsMidiaAula(disc);
  renderDisciplineLessons(disc);
}

// ==============================================================================
// 📦 INICIALIZAÇÃO & REGISTRO DO CLIENTE GLOBAL STUDYOS
// ==============================================================================

export function processarJsonImportado(rawJson, nomeArquivo = "db.json", exibirModal = false) {
  const dbNormalizado = normalizarDb(rawJson);
  store.setState({ db: dbNormalizado });

  if (dbNormalizado.semestres && dbNormalizado.semestres.length > 0) {
    store.setState({ semestresExpandidos: new Set([dbNormalizado.semestres[0].id]) });
  }

  salvarDbCache(rawJson);
  router.resolve();
}

export async function inicializarApp() {
  atualizarUiModoAdmin();
  const inputBase = document.getElementById("input-base-media-path");
  if (inputBase) inputBase.value = obterBaseMediaPath();

  // 1. Prioriza o banco real sincronizado no Firebase Realtime Database (Produção / GitHub Pages)
  const fbDb = await carregarDbFirebase();
  if (fbDb) {
    processarJsonImportado(fbDb, "db.json (Nuvem Firebase)", false);
    return;
  }

  // 2. Fallback para o arquivo local db.json (Template / Offline)
  const localDb = await carregarDbLocal();
  if (localDb) {
    processarJsonImportado(localDb, "db.json", false);
    return;
  }

  // 3. Fallback para cache local no navegador
  const cachedDb = obterDbCache();
  if (cachedDb) {
    processarJsonImportado(cachedDb, "db.json (Cache)", false);
    return;
  }

  // Fallback banco vazio
  store.setState({ db: normalizarDb(null) });
  router.resolve();
}

// API Pública global vinculada ao window / globalScope para acesso limpo
export const StudyOS = {
  filtrarPorStatus: (status) => {
    const atual = store.getState().filtroStatusAtivo;
    store.setState({ filtroStatusAtivo: atual === status ? "todos" : status });
    if (window.location.hash !== "#/") router.navigate("#/");
    else renderHomeView();
  },
  filtrarPorTag: (tag) => {
    const atual = store.getState().filtroTagAtiva;
    store.setState({ filtroTagAtiva: atual === tag ? "todas" : tag });
    if (window.location.hash !== "#/") router.navigate("#/");
    else renderHomeView();
  },
  setFiltroSemestre: (semId) => {
    store.setState({ filtroSemestreAtivo: semId });
    renderHomeView();
  },
  setFiltroStatus: (stId) => {
    store.setState({ filtroStatusAtivo: stId });
    renderHomeView();
  },
  setDatabaseViewMode: (modo) => {
    store.setState({ databaseViewMode: modo === "table" ? "table" : "gallery" });
    renderHomeView();
  },
  setFiltroTextoInline: (valor) => {
    store.setState({ filtroTextoInline: String(valor || "") });
    const input = document.getElementById("inline-db-search");
    if (input && input.value !== valor) input.value = valor;
    const btnClear = document.getElementById("btn-clear-inline-search");
    if (btnClear) btnClear.classList.toggle("hidden", !valor);
    renderDisciplinesDatabase();
  },
  limparTodosFiltros: () => {
    store.resetFilters();
    const input = document.getElementById("inline-db-search");
    if (input) input.value = "";
    renderHomeView();
  },
  recarregarVisaoAtual: () => {
    router.resolve();
  },

  // Modais dinâmicos (Lazy Imports) protegidos com exigirAdmin
  abrirModalAtividade: (discId, index) => {
    exigirAdmin("Editar / Cadastrar Avaliação", () => {
      Modals.loadAtividade().then(m => m.abrirModalAtividade(discId, index));
    });
  },
  fecharModalAtividade: () => {
    Modals.loadAtividade().then(m => m.fecharModalAtividade());
  },
  salvarModalAtividade: () => {
    exigirAdmin("Salvar Avaliação", () => {
      Modals.loadAtividade().then(m => m.salvarModalAtividade());
    });
  },
  atualizarPreviewCalculoAtividade: () => {
    Modals.loadAtividade().then(m => m.atualizarPreviewCalculoAtividade());
  },

  abrirModalEditarDisciplina: (discId) => {
    exigirAdmin("Editar Matéria e Capa", () => {
      Modals.loadDisciplineMeta().then(m => m.abrirModalEditarDisciplina(discId));
    });
  },
  fecharModalEditarDisciplina: () => {
    Modals.loadDisciplineMeta().then(m => m.fecharModalEditarDisciplina());
  },
  salvarModalEditarDisciplina: () => {
    exigirAdmin("Salvar Alterações da Matéria", () => {
      Modals.loadDisciplineMeta().then(m => m.salvarModalEditarDisciplina());
    });
  },

  abrirModalDataAula: (discId, aulaId) => {
    exigirAdmin("Alterar Data / Presença da Aula", () => {
      Modals.loadDataAula().then(m => m.abrirModalDataAula(discId, aulaId));
    });
  },
  fecharModalDataAula: () => {
    Modals.loadDataAula().then(m => m.fecharModalDataAula());
  },
  salvarModalDataAula: () => {
    exigirAdmin("Salvar Presença / Data da Aula", () => {
      Modals.loadDataAula().then(m => m.salvarModalDataAula());
    });
  },
  atualizarPreviewStatusModalAula: () => {
    Modals.loadDataAula().then(m => m.atualizarPreviewStatusModalAula());
  },
  atualizarPreviewLinksAula: () => {
    Modals.loadDataAula().then(m => m.atualizarPreviewLinksAula());
  },
  abrirModalVisualizacaoAula: (discId, aulaId) => {
    Modals.loadDataAula().then(m => m.abrirModalVisualizacaoAula(discId, aulaId));
  },
  fecharModalVisualizacaoAula: () => {
    Modals.loadDataAula().then(m => m.fecharModalVisualizacaoAula());
  },
  abrirModalArquivosReferencias: (discId, aulaId) => {
    if (!isAdminAutenticado()) {
      abrirModalSenhaAdmin("O Material Bruto (PDFs com OCR, apostilas e documentos originais) é restrito ao Administrador por proteção de direitos autorais.", () => {
        Modals.loadArquivosReferencias().then(m => m.abrirModalArquivosReferencias(discId, aulaId));
      });
      return;
    }
    Modals.loadArquivosReferencias().then(m => m.abrirModalArquivosReferencias(discId, aulaId));
  },
  fecharModalArquivosReferencias: () => {
    Modals.loadArquivosReferencias().then(m => m.fecharModalArquivosReferencias());
  },

  // Autenticação Admin
  abrirModalSenhaAdmin,
  fecharModalSenhaAdmin,
  submeterSenhaAdmin,
  encerrarSessaoAdmin: () => desautenticarAdmin(),
  isAdminAutenticado,

  abrirModalEscolhaPlaylist: () => {
    const hash = window.location.hash || "#/";
    if (!hash.startsWith("#/disciplina/")) {
      mostrarToast("Atenção", "Abra uma matéria antes de iniciar a Playlist.", "info");
      return;
    }
    const slug = decodeURIComponent(hash.replace("#/disciplina/", "").split("/")[0]);
    const disc = buscarDisciplinaPorId(slug);
    Modals.loadCinema().then(m => m.abrirModalEscolhaPlaylist(disc));
  },
  fecharModalEscolhaPlaylist: () => {
    Modals.loadCinema().then(m => m.fecharModalEscolhaPlaylist());
  },
  iniciarPlaylistModo: (tipo) => {
    const hash = window.location.hash || "#/";
    const slug = decodeURIComponent(hash.replace("#/disciplina/", "").split("/")[0]);
    const disc = buscarDisciplinaPorId(slug);
    Modals.loadCinema().then(m => m.iniciarPlaylistModo(disc, tipo));
  },
  fecharPlaylistImersiva: () => {
    Modals.loadCinema().then(m => m.fecharPlaylistImersiva());
  },
  avancarPlaylist: () => {
    Modals.loadCinema().then(m => m.avancarPlaylist());
  },
  retrocederPlaylist: () => {
    Modals.loadCinema().then(m => m.retrocederPlaylist());
  },
  pularParaItemPlaylist: (idx) => {
    Modals.loadCinema().then(m => m.pularParaItemPlaylist(idx));
  },
  toggleZoomImagemPlaylist: (e) => {
    Modals.loadCinema().then(m => m.toggleZoomImagemPlaylist(e));
  },
  handleMouseMoveZoomPlaylist: (e) => {
    Modals.loadCinema().then(m => m.handleMouseMoveZoomPlaylist(e));
  },
  handleImagemPlaylistClick: (e) => {
    Modals.loadCinema().then(m => m.handleImagemPlaylistClick(e));
  },
  alternarTelaCheiaPlaylist: () => {
    Modals.loadCinema().then(m => m.alternarTelaCheiaPlaylist());
  },

  abrirModalRelatorioImportacao: (nomeArquivo, isManual) => {
    Modals.loadImportReport().then(m => m.abrirModalRelatorioImportacao(nomeArquivo, isManual));
  },
  fecharModalRelatorioImportacao: () => {
    Modals.loadImportReport().then(m => m.fecharModalRelatorioImportacao());
  },

  // Controles de mídias e aulas
  alternarSelectMidiaAula: (midiaId) => {
    const state = store.getState();
    const totalOpcoes = OPCOES_MIDIA_AULA.length;
    let novas = new Set(state.midiasAtivasAula);

    if (novas.size === totalOpcoes) {
      novas = new Set([midiaId]);
    } else if (novas.has(midiaId)) {
      novas.delete(midiaId);
      if (novas.size === 0) novas = new Set(OPCOES_MIDIA_AULA.map(o => o.id));
    } else {
      novas.add(midiaId);
    }

    store.setState({ midiasAtivasAula: novas });
    const hash = window.location.hash || "#/";
    if (hash.startsWith("#/disciplina/")) {
      const slug = decodeURIComponent(hash.replace("#/disciplina/", "").split("/")[0]);
      const disc = buscarDisciplinaPorId(slug);
      if (disc) {
        renderBarraSelectsMidiaAula(disc);
        // Atualiza aulas abertas
        state.aulasAbertas.forEach(aulaId => {
          const aula = (disc.aulas || []).find(a => a.id === aulaId);
          const bodyEl = document.getElementById(`lesson-body-${aulaId}`);
          if (aula && bodyEl) {
            revogarBlobsDaAula(aulaId);
            bodyEl.innerHTML = montarConteudoInternoDaAula(disc, aula);
            observarMidiasLazy(bodyEl);
          }
        });
      }
    }
  },

  aplicarPresetMidiaAula: (preset) => {
    const lista = PRESETS_MIDIA[preset] || PRESETS_MIDIA["todas"];
    store.setState({ midiasAtivasAula: new Set(lista) });
    const hash = window.location.hash || "#/";
    if (hash.startsWith("#/disciplina/")) {
      const slug = decodeURIComponent(hash.replace("#/disciplina/", "").split("/")[0]);
      const disc = buscarDisciplinaPorId(slug);
      if (disc) {
        renderBarraSelectsMidiaAula(disc);
        store.getState().aulasAbertas.forEach(aulaId => {
          const aula = (disc.aulas || []).find(a => a.id === aulaId);
          const bodyEl = document.getElementById(`lesson-body-${aulaId}`);
          if (aula && bodyEl) {
            revogarBlobsDaAula(aulaId);
            bodyEl.innerHTML = montarConteudoInternoDaAula(disc, aula);
            observarMidiasLazy(bodyEl);
          }
        });
      }
    }
  },

  resetarFiltroMidiasAula: () => {
    window.StudyOS.aplicarPresetMidiaAula("todas");
  },

  aoAlternarToggleAula: (detailsEl, discId, aulaId) => {
    const disc = buscarDisciplinaPorId(discId);
    aoAlternarToggleAula(detailsEl, disc, aulaId);
  },

  abrirEFocarAula: (discId, aulaId) => {
    const detailsEl = document.getElementById(`lesson-details-${aulaId}`);
    if (!detailsEl) return;
    if (!detailsEl.open) {
      detailsEl.open = true;
    }
    detailsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  },

  ajustarModoCropJpg: (boxId, imgId, modo, btnEl) => {
    const box = document.getElementById(boxId);
    const img = document.getElementById(imgId);
    if (!box || !img) return;

    box.classList.remove("aspect-[10/16]", "aspect-[9/16]");
    img.classList.remove("object-cover", "object-contain", "scale-[1.035]", "scale-100");

    if (modo === "10-16") {
      box.classList.add("aspect-[10/16]");
      img.classList.add("object-cover", "scale-[1.035]");
    } else if (modo === "9-16") {
      box.classList.add("aspect-[9/16]");
      img.classList.add("object-cover", "scale-[1.035]");
    } else {
      img.classList.add("object-contain", "scale-100");
    }

    if (btnEl && btnEl.parentElement) {
      btnEl.parentElement.querySelectorAll("button").forEach(b => {
        b.className = "px-2 py-0.5 rounded bg-notion-card hover:bg-notion-hover text-notion-muted hover:text-white border border-notion-border font-mono text-[10px] transition-colors";
      });
      btnEl.className = "px-2 py-0.5 rounded bg-indigo-600 text-white font-mono text-[10px] transition-colors";
    }
  },

  alternarZoomJpg: (boxId) => {
    const box = document.getElementById(boxId);
    if (!box) return;
    const isZoomed = box.dataset.zoom === "large";
    if (isZoomed) {
      box.dataset.zoom = "normal";
      box.classList.remove("max-w-[880px]");
      box.classList.add("max-w-[480px]", "sm:max-w-[560px]", "lg:max-w-[650px]");
    } else {
      box.dataset.zoom = "large";
      box.classList.remove("max-w-[480px]", "sm:max-w-[560px]", "lg:max-w-[650px]");
      box.classList.add("max-w-[880px]");
    }
  },

  alternarAulasCardExpandidas: (discId, btnEl) => {
    const hiddenContainer = document.getElementById(`aulas-restantes-${discId}`);
    if (!hiddenContainer) return;
    const estaOculto = hiddenContainer.classList.contains("hidden");
    if (estaOculto) {
      if (!hiddenContainer.children.length) {
        const disc = buscarDisciplinaPorId(discId);
        if (disc && Array.isArray(disc.aulas)) {
          hiddenContainer.innerHTML = disc.aulas.slice(5).map((a, i) => renderCardAulaPillHtml(disc, a, i + 5)).join("");
        }
      }
      hiddenContainer.classList.remove("hidden");
      hiddenContainer.classList.add("flex");
      if (btnEl) btnEl.textContent = "▲ Menos";
    } else {
      hiddenContainer.classList.add("hidden");
      hiddenContainer.classList.remove("flex");
      const qtd = hiddenContainer.dataset.qtd || "";
      if (btnEl) btnEl.textContent = `+${qtd} mais`;
    }
  },

  alternarAtividadesCardExpandidas: (discId, btnEl) => {
    const hiddenContainer = document.getElementById(`ativs-restantes-${discId}`);
    if (!hiddenContainer) return;
    const estaOculto = hiddenContainer.classList.contains("hidden");
    if (estaOculto) {
      if (!hiddenContainer.children.length) {
        const disc = buscarDisciplinaPorId(discId);
        if (disc && Array.isArray(disc.atividades)) {
          hiddenContainer.innerHTML = disc.atividades.slice(2).map((a, i) => renderCardAtividadeItemHtml(disc, a, 2 + i)).join("");
        }
      }
      hiddenContainer.classList.remove("hidden");
      hiddenContainer.classList.add("flex");
      if (btnEl) btnEl.textContent = "▲ Menos";
    } else {
      hiddenContainer.classList.add("hidden");
      hiddenContainer.classList.remove("flex");
      const qtd = hiddenContainer.dataset.qtd || "";
      if (btnEl) btnEl.textContent = `+${qtd} mais atividades`;
    }
  },

  iniciarEdicaoMd: (htmlId) => {
    exigirAdmin("Editar Markdown da Aula", () => {
      document.getElementById(`md-view-${htmlId}`)?.classList.add("hidden");
      document.getElementById(`btn-edit-${htmlId}`)?.classList.add("hidden");
      document.getElementById(`md-editor-container-${htmlId}`)?.classList.remove("hidden");
    });
  },

  cancelarEdicaoMd: (htmlId) => {
    document.getElementById(`md-editor-container-${htmlId}`)?.classList.add("hidden");
    document.getElementById(`md-view-${htmlId}`)?.classList.remove("hidden");
    document.getElementById(`btn-edit-${htmlId}`)?.classList.remove("hidden");
  },

  salvarEdicaoMd: async (htmlId, localPathEncoded, arquivoCacheIdEncoded, aulaId) => {
    exigirAdmin("Salvar Edição de Markdown", async () => {
      const localPath = decodeURIComponent(localPathEncoded || "");
      const arquivoCacheId = decodeURIComponent(arquivoCacheIdEncoded || "");
      const btn = document.getElementById(`btn-save-${htmlId}`);
      const textarea = document.getElementById(`md-textarea-${htmlId}`);
      if (!textarea || !btn) return;

      const novoTexto = textarea.value;

      // Atualização otimista
      store.atualizarCacheMarkdown(arquivoCacheId, novoTexto);
      salvarEdicaoMdCache(arquivoCacheId, novoTexto);

      const htmlRenderizado = obterHtmlMarkdownParseado(novoTexto);
      const viewEl = document.getElementById(`md-view-${htmlId}`);
      if (viewEl) {
        viewEl.innerHTML = `
          <article class="prose prose-invert prose-indigo max-w-none prose-headings:tracking-tight prose-p:leading-relaxed prose-li:my-1">
            ${htmlRenderizado}
          </article>
        `;
      }

      btn.disabled = true;
      const txtOriginal = btn.innerHTML;
      btn.innerHTML = `<span class="animate-spin text-sm">⏳</span> <span>Enviando para a Fila...</span>`;

      try {
        const res = await enviarFilaEdicaoMd({ localPath, arquivoId: arquivoCacheId, novoTexto });
        if (res && res.ok === false) throw new Error(res.erro || "Falha ao enviar ao Firebase");

        mostrarToast("Salvo na Nuvem com Sucesso! 💾", `Edição salva para "${localPath.split('/').pop() || localPath}".`, "success");
        window.StudyOS.cancelarEdicaoMd(htmlId);
      } catch (err) {
        mostrarToast("Erro ao enviar ao Firebase", err.message, "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = txtOriginal;
      }
    });
  },

  salvarBaseMediaPath: () => {
    const input = document.getElementById("input-base-media-path");
    if (!input) return;
    const val = input.value.trim() || "../CienciaComputacao";
    salvarBaseMediaPath(val);
    mostrarToast("Caminho salvo!", `Prefixo local atualizado para: ${val}`, "success");
    const archModal = document.getElementById("arch-modal");
    if (archModal) {
      archModal.classList.add("hidden");
      archModal.classList.remove("flex");
    }
    router.resolve();
  },

  obterTemaAtual: () => obterTemaPreferido(),

  definirTema: (tema) => {
    const t = salvarTemaPreferido(tema);
    return aplicarTemaNoDocumento(t);
  },

  alternarTema: () => {
    const novoTema = alternarTema();
    mostrarToast(
      novoTema === "light" ? "☀️ Modo Claro Ativado" : "🌙 Modo Escuro (Padrão)",
      novoTema === "light"
        ? "Visualização alterada para o tema claro."
        : "Visualização restaurada para o tema escuro padrão.",
      "info"
    );
    return novoTema;
  }
};

// Vinculação de aliases para navegadores e HTML inline legado
if (typeof window !== "undefined") {
  window.StudyOS = StudyOS;
  window.setDatabaseViewMode = StudyOS.setDatabaseViewMode;
  window.setFiltroTextoInline = StudyOS.setFiltroTextoInline;
  window.limparTodosFiltros = StudyOS.limparTodosFiltros;
  window.salvarBaseMediaPath = StudyOS.salvarBaseMediaPath;
  window.abrirModalAtividade = StudyOS.abrirModalAtividade;
  window.fecharModalAtividade = StudyOS.fecharModalAtividade;
  window.salvarModalAtividade = StudyOS.salvarModalAtividade;
  window.atualizarPreviewCalculoAtividade = StudyOS.atualizarPreviewCalculoAtividade;
  window.abrirModalEditarDisciplina = StudyOS.abrirModalEditarDisciplina;
  window.fecharModalEditarDisciplina = StudyOS.fecharModalEditarDisciplina;
  window.salvarModalEditarDisciplina = StudyOS.salvarModalEditarDisciplina;
  window.abrirModalDataAula = StudyOS.abrirModalDataAula;
  window.fecharModalDataAula = StudyOS.fecharModalDataAula;
  window.salvarModalDataAula = StudyOS.salvarModalDataAula;
  window.atualizarPreviewStatusModalAula = StudyOS.atualizarPreviewStatusModalAula;
  window.abrirModalVisualizacaoAula = StudyOS.abrirModalVisualizacaoAula;
  window.fecharModalVisualizacaoAula = StudyOS.fecharModalVisualizacaoAula;
  window.abrirModalEscolhaPlaylist = StudyOS.abrirModalEscolhaPlaylist;
  window.fecharModalEscolhaPlaylist = StudyOS.fecharModalEscolhaPlaylist;
  window.iniciarPlaylistModo = StudyOS.iniciarPlaylistModo;
  window.fecharPlaylistImersiva = StudyOS.fecharPlaylistImersiva;
  window.avancarPlaylist = StudyOS.avancarPlaylist;
  window.retrocederPlaylist = StudyOS.retrocederPlaylist;
  window.pularParaItemPlaylist = StudyOS.pularParaItemPlaylist;
  window.toggleZoomImagemPlaylist = StudyOS.toggleZoomImagemPlaylist;
  window.handleMouseMoveZoomPlaylist = StudyOS.handleMouseMoveZoomPlaylist;
  window.handleImagemPlaylistClick = StudyOS.handleImagemPlaylistClick;
  window.alternarTelaCheiaPlaylist = StudyOS.alternarTelaCheiaPlaylist;
  window.alternarSelectMidiaAula = StudyOS.alternarSelectMidiaAula;
  window.aplicarPresetMidiaAula = StudyOS.aplicarPresetMidiaAula;
  window.resetarFiltroMidiasAula = StudyOS.resetarFiltroMidiasAula;
  window.aoAlternarToggleAula = StudyOS.aoAlternarToggleAula;
  window.abrirEFocarAula = StudyOS.abrirEFocarAula;
  window.ajustarModoCropJpg = StudyOS.ajustarModoCropJpg;
  window.alternarZoomJpg = StudyOS.alternarZoomJpg;
  window.alternarAulasCardExpandidas = StudyOS.alternarAulasCardExpandidas;
  window.alternarAtividadesCardExpandidas = StudyOS.alternarAtividadesCardExpandidas;
  window.iniciarEdicaoMd = StudyOS.iniciarEdicaoMd;
  window.cancelarEdicaoMd = StudyOS.cancelarEdicaoMd;
  window.salvarEdicaoMd = StudyOS.salvarEdicaoMd;
  window.alternarTema = StudyOS.alternarTema;
  window.definirTema = StudyOS.definirTema;
}

// ==============================================================================
// 🎯 REGISTRO DE ROTAS & EVENTOS DOM
// ==============================================================================

router.addRoute("/", () => {
  const viewHome = document.getElementById("view-home");
  const viewDisc = document.getElementById("view-discipline");
  if (viewHome && viewDisc) {
    viewDisc.classList.add("hidden");
    viewHome.classList.remove("hidden");
  }
  renderSidebar();
  renderHomeView();
});

router.addRoute("/disciplina/:id", ({ id }) => {
  const viewHome = document.getElementById("view-home");
  const viewDisc = document.getElementById("view-discipline");
  if (viewHome && viewDisc) {
    viewHome.classList.add("hidden");
    viewDisc.classList.remove("hidden");
  }
  renderSidebar();
  renderDisciplineView(id);
  document.getElementById("main-scroll-container")?.scrollTo({ top: 0 });
});

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    aplicarTemaNoDocumento(obterTemaPreferido());
    router.init();

  // Botões de colapsar / expandir todas as aulas
  document.getElementById("btn-open-all-lessons-filtered")?.addEventListener("click", () => {
    document.querySelectorAll("details[id^='lesson-details-']").forEach(el => {
      el.open = true;
    });
  });

  document.getElementById("btn-collapse-all-lessons")?.addEventListener("click", () => {
    document.querySelectorAll("details[id^='lesson-details-']").forEach(el => {
      el.open = false;
    });
    store.getState().aulasAbertas.clear();
    revogarTodosBlobs();
  });

  // Toggle do Sidebar Mobile
  document.getElementById("btn-toggle-sidebar")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.toggle("hidden");
  });

  // Expandir / Colapsar todos os semestres na árvore
  document.getElementById("btn-expand-tree")?.addEventListener("click", () => {
    store.toggleTodosSemestres();
    renderSidebar();
  });

  // Vincular pasta local do disco
  const folderInput = document.getElementById("folder-upload-input");
  folderInput?.addEventListener("change", (e) => {
    const files = e.target.files;
    const count = indexarPastaLocal(files);
    const label = document.getElementById("folder-link-label");
    if (label) label.textContent = `Pasta Local Ativa (${count} arqs)`;
    mostrarToast("Pasta Local Conectada!", `${count} arquivos indexados direto do disco.`, "success");
    router.resolve();
  });

  // Importação manual de db.json via input de arquivo
  const dbFileInput = document.getElementById("db-file-input");
  dbFileInput?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const json = JSON.parse(evt.target.result);
          processarJsonImportado(json, file.name, true);
        } catch (err) {
          mostrarToast("Erro de leitura", "Arquivo JSON inválido.", "error");
        }
      };
      reader.readAsText(file);
    }
  });

  // Drag & drop de db.json na tela
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.endsWith(".json")) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const json = JSON.parse(evt.target.result);
          processarJsonImportado(json, file.name, true);
        } catch (_) {
          mostrarToast("Erro de leitura", "Arquivo JSON inválido.", "error");
        }
      };
      reader.readAsText(file);
    }
  });

  // Modal de busca rápida (Cmd+K)
  const searchModal = document.getElementById("search-modal");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");

  const abrirBusca = () => {
    searchModal?.classList.remove("hidden");
    searchModal?.classList.add("flex");
    searchInput?.focus();
  };
  const fecharBusca = () => {
    searchModal?.classList.add("hidden");
    searchModal?.classList.remove("flex");
  };

  document.getElementById("btn-quick-search")?.addEventListener("click", abrirBusca);
  document.getElementById("btn-close-search")?.addEventListener("click", fecharBusca);

  searchInput?.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q || !searchResults) {
      if (searchResults) searchResults.innerHTML = "";
      return;
    }
    const resultados = [];
    obterTodasDisciplinas().forEach(d => {
      if (`${d.nome} ${d.prof} ${(d.TAGS || []).join(" ")}`.toLowerCase().includes(q)) {
        resultados.push({
          titulo: `${d.icone} ${d.nome}`,
          sub: `${d.semestreNome} • ${d.prof}`,
          link: `#/disciplina/${d.id}`
        });
      }
      (d.aulas || []).forEach(a => {
        const tituloAula = obterTituloAula(a, store.getState().cacheMarkdownTexto);
        if (`${a.nome} ${tituloAula}`.toLowerCase().includes(q)) {
          resultados.push({
            titulo: `📖 ${tituloAula}`,
            sub: `${d.icone} ${d.nome} (${a.nome})`,
            link: `#/disciplina/${d.id}`
          });
        }
      });
    });

    searchResults.innerHTML = resultados.slice(0, 20).map(r => `
      <a href="${r.link}" onclick="document.getElementById('search-modal').classList.add('hidden')" class="block p-2.5 rounded-xl hover:bg-notion-hover transition-colors">
        <div class="font-semibold text-notion-text">${escapeHtml(r.titulo)}</div>
        <div class="text-[11px] text-notion-muted">${escapeHtml(r.sub)}</div>
      </a>
    `).join("") || `<div class="p-4 text-center text-notion-muted">Nenhum resultado encontrado.</div>`;
  });

  // Botões de Relatório e Cache
  const fecharImport = () => {
    const m = document.getElementById("import-success-modal");
    m?.classList.add("hidden");
    m?.classList.remove("flex");
  };
  document.getElementById("btn-close-import-modal")?.addEventListener("click", fecharImport);
  document.getElementById("btn-confirm-import-modal")?.addEventListener("click", fecharImport);
  document.getElementById("btn-show-sync-report")?.addEventListener("click", () => {
    window.StudyOS.abrirModalRelatorioImportacao("db.json", false);
  });
  document.getElementById("btn-reset-db-cache")?.addEventListener("click", () => {
    limparDbCache();
    store.setState({ db: normalizarDb(null), cacheMarkdownTexto: {} });
    fecharImport();
    router.resolve();
    mostrarToast("Cache limpo", "O banco salvo no navegador foi removido.", "info");
  });

  // Atalhos Globais de Teclado (Escape fecha modais, Cmd+K busca, setas na playlist)
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      abrirBusca();
      return;
    }

    if (e.key === "Escape") {
      fecharBusca();
      window.StudyOS.fecharModalVisualizacaoAula();
      window.StudyOS.fecharModalAtividade();
      window.StudyOS.fecharModalEditarDisciplina();
      window.StudyOS.fecharModalDataAula();
      window.StudyOS.fecharPlaylistImersiva();
      window.StudyOS.fecharModalRelatorioImportacao();
      window.StudyOS.fecharModalArquivosReferencias();
      return;
    }

    // Modo Cinema Shortcuts
    const modalImersivo = document.getElementById("playlist-immersive-modal");
    if (modalImersivo && !modalImersivo.classList.contains("hidden")) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        window.StudyOS.avancarPlaylist();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        window.StudyOS.retrocederPlaylist();
      } else if ((e.key === "z" || e.key === "Z")) {
        window.StudyOS.toggleZoomImagemPlaylist();
      } else if ((e.key === "f" || e.key === "F") && !["input", "textarea"].includes(e.target.tagName.toLowerCase())) {
        window.StudyOS.alternarTelaCheiaPlaylist();
      }
    }
  });

  inicializarApp();
  });
}

