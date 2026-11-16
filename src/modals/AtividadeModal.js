/**
 * Study OS V2 - AtividadeModal (Lazy Loaded via Dynamic Import)
 * Modal de cadastro e edição de atividades com notas e anotações,
 * cálculo dinâmico de porcentagem em tempo real e sincronização na fila do Notion.
 */

import { store, buscarRefDisciplina } from "../core/store.js";
import { mostrarToast } from "../utils/domHelpers.js";
import { enviarFilaEdicaoAtividade } from "../services/api.js";

/**
 * Atualiza o badge de preview dinâmico de nota obtida e porcentagem.
 */
export function atualizarPreviewCalculoAtividade() {
  if (typeof document === "undefined") return;

  const obt = parseFloat(document.getElementById("form-ativ-nota-obtida")?.value) || 0;
  const max = parseFloat(document.getElementById("form-ativ-nota-maxima")?.value) || 0;
  const notaEl = document.getElementById("form-ativ-preview-nota");
  const pctEl = document.getElementById("form-ativ-preview-pct");
  if (!notaEl || !pctEl) return;

  notaEl.textContent = `${obt} / ${max}`;
  if (max > 0) {
    const pct = Math.round((obt / max) * 100);
    pctEl.textContent = `${pct}%`;
    pctEl.className = pct >= 70
      ? "px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/35 font-mono font-bold text-emerald-300 text-xs"
      : (pct >= 50
        ? "px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/35 font-mono font-bold text-amber-300 text-xs"
        : "px-2.5 py-1 rounded-lg bg-rose-500/20 border border-rose-500/35 font-mono font-bold text-rose-300 text-xs");
  } else {
    pctEl.textContent = "—";
  }
}

/**
 * Abre o modal para cadastro de nova atividade ou edição de uma existente.
 * @param {string} discId
 * @param {number} index -1 para nova atividade, ou índice existente
 */
export function abrirModalAtividade(discId, index = -1) {
  if (typeof document === "undefined") return;

  const ref = buscarRefDisciplina(discId);
  if (!ref) return;
  const { disc } = ref;

  store.setState({
    disciplinaModalAtiva: disc,
    indexAtividadeModalAtiva: index
  });

  const isNova = index === -1 || index === undefined || !disc.atividades || !disc.atividades[index];
  const ativ = isNova ? {
    nome: "",
    status: "A fazer",
    tipo: "Atividade",
    avaliacao: "A1",
    nota_obtida: 0,
    nota_maxima: 10,
    data: "",
    corpo_md: ""
  } : disc.atividades[index];

  const titHeader = document.getElementById("modal-ativ-titulo-header");
  if (titHeader) titHeader.textContent = isNova ? "Nova Atividade Valendo Nota" : `Editar Atividade — ${disc.nome}`;

  const nomeInput = document.getElementById("form-ativ-nome");
  const statusInput = document.getElementById("form-ativ-status");
  const tipoInput = document.getElementById("form-ativ-tipo");
  const avaliacaoInput = document.getElementById("form-ativ-avaliacao");
  const obtInput = document.getElementById("form-ativ-nota-obtida");
  const maxInput = document.getElementById("form-ativ-nota-maxima");
  const dataInput = document.getElementById("form-ativ-data");
  const corpoMdInput = document.getElementById("form-ativ-corpo-md");

  if (nomeInput) nomeInput.value = ativ.nome || "";
  if (statusInput) statusInput.value = ativ.status || "A fazer";
  if (tipoInput) tipoInput.value = ativ.tipo || "Atividade";
  if (avaliacaoInput) avaliacaoInput.value = ativ.avaliacao || "A1";
  if (obtInput) obtInput.value = ativ.nota_obtida !== undefined ? ativ.nota_obtida : 0;
  if (maxInput) maxInput.value = ativ.nota_maxima !== undefined ? ativ.nota_maxima : 10;
  if (dataInput) dataInput.value = ativ.data || "";
  if (corpoMdInput) corpoMdInput.value = ativ.corpo_md || "";

  atualizarPreviewCalculoAtividade();

  const modal = document.getElementById("modal-atividade");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
}

/**
 * Fecha o modal de atividade.
 */
export function fecharModalAtividade() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-atividade");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
  store.setState({ disciplinaModalAtiva: null, indexAtividadeModalAtiva: -1 });
}

/**
 * Salva a atividade de forma otimista e envia payload para a fila do Notion no Firebase.
 */
export async function salvarModalAtividade() {
  if (typeof document === "undefined") return;

  const state = store.getState();
  const disc = state.disciplinaModalAtiva;
  if (!disc) return;

  const nome = document.getElementById("form-ativ-nome")?.value.trim();
  if (!nome) {
    mostrarToast("Atenção", "Por favor, informe o nome da atividade.", "error");
    return;
  }

  const status = document.getElementById("form-ativ-status")?.value || "A fazer";
  const tipo = document.getElementById("form-ativ-tipo")?.value.trim() || "Atividade";
  const avaliacao = document.getElementById("form-ativ-avaliacao")?.value || "A1";
  const notaObtida = parseFloat(document.getElementById("form-ativ-nota-obtida")?.value) || 0;
  const notaMaxima = parseFloat(document.getElementById("form-ativ-nota-maxima")?.value) || 0;
  const dataAtiv = document.getElementById("form-ativ-data")?.value || "";
  const corpoMd = document.getElementById("form-ativ-corpo-md")?.value || "";

  const btn = document.getElementById("btn-salvar-modal-ativ");
  const txtOriginal = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin text-sm">⏳</span> <span>Salvando no Notion...</span>`;
  }

  const idx = state.indexAtividadeModalAtiva;
  const isNova = idx === -1 || idx === undefined || !disc.atividades || !disc.atividades[idx];
  const nomeAntigo = isNova ? "" : disc.atividades[idx].nome;

  const dadosAtiv = {
    nome,
    status,
    tipo,
    avaliacao,
    nota_obtida: notaObtida,
    nota_maxima: notaMaxima,
    data: dataAtiv,
    corpo_md: corpoMd
  };

  // Atualização Otimista no Store
  if (!disc.atividades) disc.atividades = [];
  if (isNova) {
    disc.atividades.push(dadosAtiv);
  } else {
    disc.atividades[idx] = dadosAtiv;
  }
  store.notify();

  try {
    const res = await enviarFilaEdicaoAtividade({
      nomeMateria: disc.nomeOriginal || disc.nome,
      nomeAntigo,
      atividade: dadosAtiv
    });

    if (res && res.ok === false) {
      throw new Error(res.erro || "Falha ao enviar para o Firebase");
    }

    mostrarToast("Atividade Salva! 💾", `Atividade "${nome}" sincronizada com sucesso.`, "success");
    fecharModalAtividade();

    if (window.StudyOS && typeof window.StudyOS.recarregarVisaoAtual === "function") {
      window.StudyOS.recarregarVisaoAtual();
    }
  } catch (err) {
    mostrarToast("Erro ao sincronizar atividade", err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = txtOriginal;
    }
  }
}
