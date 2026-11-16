/**
 * Study OS V2 - DisciplineCard Component
 * Card de matéria ultra otimizado com content-visibility,
 * renderização de status do Notion, tags filtráveis, atividades valendo nota
 * e pílulas de controle de presença/revisão das aulas.
 */

import { escapeHtml, extrairNumeroAula } from "../utils/domHelpers.js";
import { calcularStatusAula } from "../core/store.js";
import { otimizarUrlCapa } from "../services/mediaResolver.js";

/**
 * Retorna o HTML do badge de status da disciplina (Aprovado, Em andamento, DP).
 */
export function getStatusBadgeHtml(status, clicavel = false) {
  const s = String(status || "").toLowerCase();
  let cor = "bg-blue-500/15 text-blue-300 border-blue-500/30";
  let dot = "bg-blue-400";
  let label = status || "Em andamento";

  if (s.includes("aprovado")) {
    cor = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    dot = "bg-emerald-400";
    label = "Aprovado";
  } else if (s === "dp") {
    cor = "bg-rose-500/15 text-rose-300 border-rose-500/30";
    dot = "bg-rose-400";
    label = "DP";
  }

  const attrClick = clicavel
    ? `onclick="event.preventDefault(); event.stopPropagation(); window.StudyOS?.filtrarPorStatus('${escapeHtml(label)}');" title="Filtrar por Status: ${escapeHtml(label)}"`
    : "";

  return `
    <span ${attrClick} class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${cor} ${clicavel ? 'cursor-pointer hover:brightness-125 transition-all' : ''}">
      <span class="w-1.5 h-1.5 rounded-full ${dot}"></span>
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

/**
 * Verifica se a tag apenas repete o nome da pasta/semestre (já filtrável na linha de Pastas).
 * @param {string} tag
 * @returns {boolean}
 */
export function ehTagRedundanteDePasta(tag) {
  const t = String(tag || "").trim();
  return /\bsemestre\b/i.test(t) || /^cursos?$/i.test(t);
}

/**
 * Ordena tags por categoria lógica:
 * 1. Anos -> 2. Modalidade (EAD) -> 3. Dias da Semana -> 4. Blocos -> 5. Labs -> 6. Salas -> 7. Outras.
 * @param {string[]} tags
 * @returns {string[]}
 */
export function ordenarTagsSemanticamente(tags = []) {
  const ORDEM_DIAS = {
    segunda: 1,
    terça: 2,
    terca: 2,
    quarta: 3,
    quinta: 4,
    sexta: 5,
    sábado: 6,
    sabado: 6
  };

  function classificar(tag) {
    const t = String(tag || "").trim();
    const l = t.toLowerCase();
    if (/^202\d$/.test(t)) return [1, parseInt(t, 10), t];
    if (l === "ead" || l.includes("online")) return [2, 0, t];
    if (ORDEM_DIAS[l]) return [3, ORDEM_DIAS[l], t];
    if (l.startsWith("bloco ")) return [4, 0, t];
    if (l.includes("lab")) {
      const num = parseInt((t.match(/\d+/) || [0])[0], 10);
      return [5, num, t];
    }
    if (l.startsWith("sala ")) {
      const num = parseInt((t.match(/\d+/) || [0])[0], 10);
      return [6, num, t];
    }
    return [7, 0, t];
  }

  return [...tags].sort((a, b) => {
    const [gA, nA, sA] = classificar(a);
    const [gB, nB, sB] = classificar(b);
    if (gA !== gB) return gA - gB;
    if (nA !== nB) return nA - nB;
    return sA.localeCompare(sB, "pt-BR");
  });
}

/**
 * Formata uma tag como pill colorida com ícone semântico.
 */
export function formatarTagPillHtml(tag, filtroAtivo = "todas", clicavel = true) {
  const t = String(tag || "").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  let icone = "🏷️";
  let estilo = "bg-notion-card text-notion-muted border-notion-border hover:text-notion-text";

  if (/^202\d$/.test(t)) {
    icone = "📅";
    estilo = "bg-indigo-500/10 text-indigo-300 border-indigo-500/25";
  } else if (lower.includes("semestre") || lower.includes("curso")) {
    icone = "🎓";
    estilo = "bg-violet-500/10 text-violet-300 border-violet-500/25";
  } else if (["segunda", "terca", "terça", "quarta", "quinta", "sexta", "sabado", "sábado"].some(d => lower.includes(d))) {
    icone = "🕒";
    estilo = "bg-amber-500/10 text-amber-300 border-amber-500/25";
  } else if (lower.includes("ead") || lower.includes("online")) {
    icone = "🌐";
    estilo = "bg-cyan-500/10 text-cyan-300 border-cyan-500/25";
  } else if (lower.startsWith("bloco ")) {
    icone = "🏢";
    estilo = "bg-purple-500/10 text-purple-300 border-purple-500/25";
  } else if (lower.startsWith("sala ")) {
    icone = "🚪";
    estilo = "bg-sky-500/10 text-sky-300 border-sky-500/25";
  } else if (lower.includes("lab")) {
    icone = "🖥️";
    estilo = "bg-emerald-500/10 text-emerald-300 border-emerald-500/25";
  }

  const ativo = String(filtroAtivo).toLowerCase() === lower;
  if (ativo) {
    estilo = "bg-indigo-600 text-white border-indigo-400 shadow-xs";
  }

  const clickAttr = clicavel
    ? `onclick="event.preventDefault(); event.stopPropagation(); window.StudyOS?.filtrarPorTag('${escapeHtml(t)}');"`
    : "";

  return `
    <span ${clickAttr} class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono border ${estilo} ${clicavel ? 'cursor-pointer hover:border-indigo-400 transition-colors' : ''}">
      <span>${icone}</span>
      <span>${escapeHtml(t)}</span>
    </span>
  `;
}

/**
 * Retorna badge de status de uma atividade individual (A fazer, Fazendo, Concluído).
 */
export function getStatusAtividadeBadge(status, clicavel = false, clickAction = "") {
  const s = String(status || "").trim().toLowerCase();
  let cor = "bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30";
  let dot = "bg-rose-400";
  let label = status || "A fazer";

  if (s.includes("conclu") || s.includes("feito") || s.includes("entregue")) {
    cor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30";
    dot = "bg-emerald-400";
    label = "Concluído";
  } else if (s.includes("fazendo") || s.includes("andamento") || s.includes("progresso")) {
    cor = "bg-sky-500/20 text-sky-300 border-sky-500/40 hover:bg-sky-500/30";
    dot = "bg-sky-400";
    label = "Fazendo";
  } else {
    cor = "bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30";
    dot = "bg-rose-400";
    label = "A fazer";
  }

  const clickAttr = clicavel && clickAction
    ? `onclick="event.preventDefault(); event.stopPropagation(); ${clickAction}"`
    : "";

  return `
    <span ${clickAttr} class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${cor} ${clicavel ? 'cursor-pointer transition-all shadow-xs' : ''}">
      <span class="w-1.5 h-1.5 rounded-full ${dot}"></span>
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

/**
 * Rótulo numérico para o botão da aula.
 */
export function obterRotuloNumeroAula(nome, idx) {
  if (!nome) return String(idx + 1);
  if (nome.toLowerCase().includes("materiais") || nome.toLowerCase().includes("arquivos")) return "📁";
  const num = extrairNumeroAula(nome);
  return num !== null ? String(num) : String(idx + 1);
}

/**
 * Pílula de aula no card com indicação de presença, falta ou revisão.
 */
export function renderCardAulaPillHtml(disc, aula, idxGlobal) {
  const rotulo = obterRotuloNumeroAula(aula.nome, idxGlobal);
  const st = calcularStatusAula(aula);
  let estilo = "bg-notion-sidebar hover:bg-indigo-600 text-notion-muted hover:text-white border-notion-border hover:border-indigo-400";
  let statusDesc = "";

  if (st.presenca) {
    estilo = "bg-emerald-500/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border-emerald-500/40";
    statusDesc = "• ✅ Presente";
  } else if (st.falta) {
    estilo = "bg-rose-500/25 hover:bg-rose-600 text-rose-300 hover:text-white border-rose-500/45 font-bold";
    statusDesc = "• 🟥 Falta";
  } else if (st.temData) {
    estilo = "bg-cyan-500/15 hover:bg-cyan-600 text-cyan-300 hover:text-white border-cyan-500/35";
    statusDesc = "• 📅 Agendada";
  }

  if (st.revisao) {
    statusDesc += " • 🆗 Revisão Concluída";
  }

  return `
    <button
      type="button"
      onclick="event.preventDefault(); event.stopPropagation(); window.StudyOS?.abrirModalVisualizacaoAula('${disc.id}', '${aula.id}')"
      title="${escapeHtml(aula.nome)} ${aula.data_aula ? '• 📅 ' + aula.data_aula : ''} ${statusDesc}"
      class="relative w-6 h-6 rounded-md border font-mono text-[10px] font-semibold flex items-center justify-center transition-colors duration-75 cursor-pointer shadow-xs ${estilo}"
    >
      ${escapeHtml(rotulo)}
      ${st.revisao ? `<span class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-violet-400 border border-black shadow-xs" title="Revisão Concluída"></span>` : ""}
    </button>
  `;
}

/**
 * Renderiza o controle compacto de aulas no card da matéria.
 */
export function renderCardAulasNumerosHtml(disc) {
  const aulas = disc.aulas || [];
  if (aulas.length === 0) return `<span class="text-[10px] text-notion-muted font-mono">Sem aulas</span>`;

  const limite = 5;
  const visiveis = aulas.slice(0, limite);
  const restantes = aulas.slice(limite);

  return `
    <div class="flex items-center gap-1 flex-wrap">
      ${visiveis.map((a, i) => renderCardAulaPillHtml(disc, a, i)).join("")}
      ${restantes.length > 0 ? `
        <div id="aulas-restantes-${disc.id}" class="hidden flex-wrap gap-1" data-qtd="${restantes.length}"></div>
        <button
          type="button"
          onclick="event.preventDefault(); event.stopPropagation(); window.StudyOS?.alternarAulasCardExpandidas('${disc.id}', this)"
          class="px-1.5 py-0.5 rounded-md bg-indigo-500/15 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 font-mono text-[10px] font-semibold transition-colors duration-75 cursor-pointer shadow-xs"
        >
          +${restantes.length} mais
        </button>
      ` : ""}
    </div>
  `;
}

/**
 * Item individual de atividade no card da matéria.
 */
export function renderCardAtividadeItemHtml(disc, ativ, idx) {
  const st = ativ.status || "A fazer";
  const sLower = st.toLowerCase();
  let badgeClass = "bg-rose-500/20 text-rose-300 border-rose-500/30";
  let dotClass = "bg-rose-400";
  if (sLower.includes("conclu")) {
    badgeClass = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    dotClass = "bg-emerald-400";
  } else if (sLower.includes("fazendo")) {
    badgeClass = "bg-sky-500/20 text-sky-300 border-sky-500/30";
    dotClass = "bg-sky-400";
  }

  return `
    <button
      type="button"
      onclick="event.preventDefault(); event.stopPropagation(); window.StudyOS?.abrirModalAtividade('${disc.id}', ${idx})"
      title="${escapeHtml(ativ.nome)}: ${escapeHtml(st)} (Clique para abrir detalhes)"
      class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-notion-sidebar hover:bg-indigo-600/20 border border-notion-border hover:border-indigo-500/40 text-[11px] transition-colors duration-75 cursor-pointer text-left w-full"
    >
      <span class="truncate flex items-center gap-1.5 text-notion-text">
        <span class="shrink-0 text-xs">${disc.icone || '📝'}</span>
        <span class="truncate">${escapeHtml(ativ.nome)}</span>
      </span>
      <span class="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium border ${badgeClass}">
        <span class="w-1.5 h-1.5 rounded-full ${dotClass}"></span>
        <span>${escapeHtml(st)}</span>
      </span>
    </button>
  `;
}

/**
 * Lista de atividades e rollup de nota calculada dentro do card.
 */
export function renderCardAtividadesHtml(disc) {
  const ativs = disc.atividades || [];
  if (ativs.length === 0) return "";

  const limite = 2;
  const visiveis = ativs.slice(0, limite);
  const restantes = ativs.slice(limite);

  let somaObt = 0;
  let somaMax = 0;
  ativs.forEach(a => {
    somaObt += parseFloat(a.nota_obtida) || 0;
    somaMax += parseFloat(a.nota_maxima) || 0;
  });
  const notaFinalHtml = somaMax > 0
    ? `<span class="px-2 py-0.5 rounded-md bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-amber-300 font-bold">🏆 ${somaObt.toFixed(1)} / ${somaMax.toFixed(1)}</span>`
    : "";

  return `
    <div class="space-y-1 pt-2 border-t border-notion-border/50">
      <div class="flex items-center justify-between text-[10px] font-mono text-notion-muted">
        <span class="font-bold uppercase tracking-wider text-indigo-300/80">📋 Atividades (${ativs.length}):</span>
        ${notaFinalHtml}
      </div>
      <div class="flex flex-col gap-1">
        ${visiveis.map((a, i) => renderCardAtividadeItemHtml(disc, a, i)).join("")}
        ${restantes.length > 0 ? `
          <div id="ativs-restantes-${disc.id}" class="hidden flex-col gap-1" data-qtd="${restantes.length}"></div>
          <button
            type="button"
            onclick="event.preventDefault(); event.stopPropagation(); window.StudyOS?.alternarAtividadesCardExpandidas('${disc.id}', this)"
            class="text-[10px] font-mono text-indigo-400 hover:text-indigo-300 font-semibold self-start transition-colors duration-75 cursor-pointer"
          >
            +${restantes.length} mais atividades
          </button>
        ` : ""}
      </div>
    </div>
  `;
}

/**
 * Renderiza o card completo da matéria no formato Galeria (com content-visibility).
 */
export function renderDisciplineCardHtml(disc, filtroTagAtiva = "todas") {
  const totalAulas = (disc.aulas || []).length;
  const comNb = (disc.aulas || []).filter(a => a.linkNotebookLLM).length;
  const pdfsSemOcrCount = (disc.aulas || []).reduce((acc, a) =>
    acc + (a.arquivos || []).filter(arq => arq.tipo === "pdf" && (arq.temOCR === false || arq.statusOCR === "sem_ocr")).length, 0);
  const coverUrl = otimizarUrlCapa(disc.cover);

  return `
    <div onclick="window.location.hash='#/disciplina/${disc.id}'" class="discipline-card rounded-2xl bg-notion-card hover:bg-notion-hover border border-notion-border hover:border-indigo-500/80 overflow-hidden flex flex-col transition-colors duration-100 min-h-[340px] cursor-pointer shadow-xs">
      <div class="h-36 sm:h-40 w-full bg-zinc-950 relative overflow-hidden border-b border-notion-border shrink-0 pointer-events-none">
        <img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(disc.nome)}" loading="lazy" decoding="async" class="w-full h-full object-cover" onerror="this.src='https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=420&q=70'" />
        <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/40 pointer-events-none"></div>
        <div class="absolute top-3 left-3">
          <span class="px-2.5 py-1 rounded-lg bg-black/80 backdrop-blur-xs text-[11px] font-mono text-white border border-white/15 shadow-sm pointer-events-auto">
            ${escapeHtml(disc.semestreNome)}
          </span>
        </div>
        <div class="absolute top-3 right-3 pointer-events-auto">
          ${getStatusBadgeHtml(disc.status, true)}
        </div>
      </div>

      <div class="p-4 sm:p-5 flex-1 flex flex-col justify-between space-y-2.5">
        <div class="space-y-1.5">
          <div class="flex items-start gap-2.5">
            <span class="text-2xl shrink-0 leading-none mt-0.5 select-none">${disc.icone || '📘'}</span>
            <h3 class="text-sm sm:text-base font-bold text-notion-text hover:text-indigo-300 transition-colors duration-75 leading-snug">
              ${escapeHtml(disc.nome)}
            </h3>
          </div>

          <div class="flex flex-wrap gap-1">
            ${ordenarTagsSemanticamente((disc.TAGS || []).filter(t => !ehTagRedundanteDePasta(t))).map(t => formatarTagPillHtml(t, filtroTagAtiva, true)).join("")}
          </div>

          <p class="text-xs text-notion-muted truncate">👤 ${escapeHtml(disc.prof || 'Professor não informado')}</p>
        </div>

        ${renderCardAtividadesHtml(disc)}

        <div class="space-y-1 pt-2 border-t border-notion-border/50">
          <div class="flex items-center justify-between text-[10px] font-mono text-notion-muted">
            <span class="font-bold uppercase tracking-wider text-indigo-300/80">📖 Controle de Aulas (${totalAulas}):</span>
            <span class="text-notion-muted text-[10px]">${pdfsSemOcrCount} PDFs Sem OCR</span>
          </div>
          ${renderCardAulasNumerosHtml(disc)}
        </div>

        <div class="pt-2 border-t border-notion-border/40 flex items-center justify-between text-[11px] font-mono text-notion-muted">
          <span class="flex items-center gap-1">
            <span>🤖</span>
            <span class="${comNb > 0 ? 'text-indigo-300 font-semibold' : 'text-notion-muted'}">${comNb}/${totalAulas} NotebookLM</span>
          </span>
          <span class="text-[10px] text-indigo-400 font-medium">Abrir matéria →</span>
        </div>
      </div>
    </div>
  `;
}
