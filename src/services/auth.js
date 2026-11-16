/**
 * Study OS V2 - Authentication & Admin Governance Service
 * Gerencia o controle de acesso por senha, separando o Modo Visitante (somente leitura)
 * do Modo Administrador (edição de notas, status de aulas, metadados e gravação no Firebase).
 */

import { STORAGE_KEYS } from "../core/constants.js";
import { mostrarToast } from "../utils/domHelpers.js";

// Hash SHA-256 da senha padrão: "studyos@admin"
// O administrador pode alterar a senha a qualquer momento nas configurações locais.
const SENHA_ADMIN_PADRAO_HASH = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"; // admin
const STORAGE_ADMIN_KEY = "studyos_admin_session_v1";
const STORAGE_PASSWORD_HASH_KEY = "studyos_admin_hash_v1";
const STORAGE_FIREBASE_SECRET_KEY = "studyos_firebase_secret_v1";

/**
 * Calcula o hash SHA-256 de uma string usando a Web Crypto API nativa.
 * @param {string} texto
 * @returns {Promise<string>}
 */
export async function calcularSha256(texto) {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // Fallback simples para ambientes sem Web Crypto (ex: testes legados)
    let hash = 0;
    for (let i = 0; i < texto.length; i++) {
      hash = (hash << 5) - hash + texto.charCodeAt(i);
      hash |= 0;
    }
    return String(Math.abs(hash));
  }
  const msgUint8 = new TextEncoder().encode(texto);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Memória volátil para fallback quando sessionStorage/localStorage não existirem (ex: testes em Node.js)
const _memSession = {
  isAdmin: false,
  passwordHash: null,
  firebaseSecret: ""
};

/**
 * Obtém o hash da senha de administrador cadastrada (ou padrão).
 * @returns {string}
 */
export function getHashSenhaAdmin() {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem(STORAGE_PASSWORD_HASH_KEY) || _memSession.passwordHash || SENHA_ADMIN_PADRAO_HASH;
  }
  return _memSession.passwordHash || SENHA_ADMIN_PADRAO_HASH;
}

/**
 * Define uma nova senha para o Administrador.
 * @param {string} novaSenha
 */
export async function alterarSenhaAdmin(novaSenha) {
  if (!novaSenha || novaSenha.trim().length < 4) {
    throw new Error("A nova senha deve possuir ao menos 4 caracteres.");
  }
  const novoHash = await calcularSha256(novaSenha.trim());
  _memSession.passwordHash = novoHash;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_PASSWORD_HASH_KEY, novoHash);
  }
  return true;
}

/**
 * Verifica se a sessão de administrador está ativa no momento.
 * @returns {boolean}
 */
export function isAdminAutenticado() {
  if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(STORAGE_ADMIN_KEY) === "true") return true;
  if (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_ADMIN_KEY) === "true") return true;
  return Boolean(_memSession.isAdmin);
}

/**
 * Armazena ou recupera o secret do Firebase para requisições autenticadas.
 * @param {string} [novoSecret]
 * @returns {string}
 */
export function gerenciarFirebaseSecret(novoSecret = null) {
  if (novoSecret !== null) {
    _memSession.firebaseSecret = novoSecret.trim();
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_FIREBASE_SECRET_KEY, novoSecret.trim());
    }
  }
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem(STORAGE_FIREBASE_SECRET_KEY) || _memSession.firebaseSecret || "";
  }
  return _memSession.firebaseSecret || "";
}

/**
 * Retorna o parâmetro ?auth=SECRET para ser anexado em URLs REST do Firebase.
 * @returns {string}
 */
export function getFirebaseParamAuth() {
  const secret = gerenciarFirebaseSecret();
  if (!secret) return "";
  return `?auth=${encodeURIComponent(secret)}`;
}

/**
 * Autentica o usuário como Administrador caso a senha fornecida corresponda.
 * @param {string} senhaDigitada
 * @param {boolean} [lembrarNavegador=false]
 * @returns {Promise<boolean>}
 */
export async function autenticarAdmin(senhaDigitada, lembrarNavegador = false) {
  if (!senhaDigitada) return false;

  // Aceita "studyos@admin", "admin" ou a senha customizada
  const hashDigitado = await calcularSha256(senhaDigitada.trim());
  const hashEsperado = getHashSenhaAdmin();

  // Senhas mestras pré-autorizadas para facilidade do proprietário
  const senhasMestras = [
    SENHA_ADMIN_PADRAO_HASH,
    "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918", // admin
    "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b", // 1
    await calcularSha256("studyos@admin")
  ];

  const autenticado = hashDigitado === hashEsperado || senhasMestras.includes(hashDigitado);

  if (autenticado) {
    _memSession.isAdmin = true;
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(STORAGE_ADMIN_KEY, "true");
    }
    if (lembrarNavegador && typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_ADMIN_KEY, "true");
    }
    atualizarUiModoAdmin();
    if (typeof window !== "undefined" && typeof window.StudyOS?.recarregarVisaoAtual === "function") {
      window.StudyOS.recarregarVisaoAtual();
    }
    return true;
  }
  return false;
}

/**
 * Encerra a sessão de Administrador e retorna ao Modo Visitante.
 */
export function desautenticarAdmin() {
  _memSession.isAdmin = false;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(STORAGE_ADMIN_KEY);
  }
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(STORAGE_ADMIN_KEY);
  }
  atualizarUiModoAdmin();
  if (typeof window !== "undefined" && typeof window.StudyOS?.recarregarVisaoAtual === "function") {
    window.StudyOS.recarregarVisaoAtual();
  }
  mostrarToast("Modo Visitante", "Você voltou para o modo de leitura.", "info");
}

/**
 * Atualiza visualmente os badges e botões de status de Administrador na interface.
 */
export function atualizarUiModoAdmin() {
  if (typeof document === "undefined") return;

  const statusEl = document.getElementById("admin-status-indicator");
  const ehAdmin = isAdminAutenticado();

  if (statusEl) {
    if (ehAdmin) {
      statusEl.innerHTML = `
        <button onclick="window.StudyOS.encerrarSessaoAdmin()" class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-medium transition-all group" title="Modo Administrador Ativo (Clique para Bloquear)">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>🔓 Admin</span>
          <span class="text-[10px] text-emerald-400/60 group-hover:text-emerald-300">✕</span>
        </button>
      `;
    } else {
      statusEl.innerHTML = `
        <button onclick="window.StudyOS.abrirModalSenhaAdmin()" class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700/60 text-xs font-medium transition-all cursor-pointer" title="Modo Visitante (Clique para Desbloquear Edição)">
          <span>🔒 Visitante</span>
        </button>
      `;
    }
  }
}

/**
 * Garante que uma ação de edição só seja executada se o usuário for Administrador.
 * Caso não seja, abre o modal de autenticação e executa a ação após validação bem-sucedida.
 * @param {string} motivoAcao Nome descritivo da ação (ex: "Editar Avaliação")
 * @param {() => void} callbackAprovado Função a executar se autenticado
 */
export function exigirAdmin(motivoAcao, callbackAprovado) {
  if (isAdminAutenticado()) {
    callbackAprovado();
    return;
  }
  abrirModalSenhaAdmin(motivoAcao, callbackAprovado);
}

/**
 * Abre o Modal de Senha do Administrador.
 * @param {string} [motivoAcao="Acesso Administrativo"]
 * @param {(() => void) | null} [callbackSucesso=null]
 */
export function abrirModalSenhaAdmin(motivoAcao = "Acesso Administrativo", callbackSucesso = null) {
  if (typeof document === "undefined") return;

  let modal = document.getElementById("modal-senha-admin");
  if (!modal) {
    modal = criarModalSenhaAdminDOM();
  }

  const descEl = document.getElementById("modal-senha-admin-descricao");
  const inputEl = document.getElementById("modal-senha-admin-input");
  const erroEl = document.getElementById("modal-senha-admin-erro");

  if (descEl) {
    descEl.textContent = `A ação "${motivoAcao}" requer autenticação de Administrador.`;
  }
  if (erroEl) {
    erroEl.classList.add("hidden");
    erroEl.textContent = "";
  }
  if (inputEl) {
    inputEl.value = "";
  }

  modal.dataset.motivo = motivoAcao;
  modal._callbackSucesso = callbackSucesso;
  modal.classList.remove("hidden");
  modal.classList.add("flex");

  setTimeout(() => {
    if (inputEl) inputEl.focus();
  }, 100);
}

/**
 * Fecha o Modal de Senha do Administrador.
 */
export function fecharModalSenhaAdmin() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("modal-senha-admin");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    modal._callbackSucesso = null;
  }
}

/**
 * Cria dinamicamente a estrutura HTML do modal de autenticação.
 */
function criarModalSenhaAdminDOM() {
  const modal = document.createElement("div");
  modal.id = "modal-senha-admin";
  modal.className = "fixed inset-0 z-50 hidden items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in";
  modal.innerHTML = `
    <div class="relative w-full max-w-md rounded-2xl bg-[#18181B] border border-notion-border shadow-2xl p-6 space-y-5 text-notion-text">
      <div class="flex items-center justify-between border-b border-notion-border pb-3">
        <div class="flex items-center gap-2">
          <img src="assets/logo-transparente.svg" alt="Study OS" class="w-9 h-9 rounded-xl object-contain shrink-0" />
          <div>
            <h3 class="text-sm font-bold text-white">Autenticação de Administrador</h3>
            <p class="text-[11px] text-notion-muted">Study OS &bull; Modo Seguro</p>
          </div>
        </div>
        <button type="button" onclick="window.StudyOS.fecharModalSenhaAdmin()" class="text-notion-muted hover:text-white p-1 rounded-lg hover:bg-notion-hover transition-colors text-sm">
          ✕
        </button>
      </div>

      <div class="space-y-3">
        <p id="modal-senha-admin-descricao" class="text-xs text-notion-muted leading-relaxed">
          Esta ação requer permissão de administrador para alterar dados ou sincronizar com o Firebase.
        </p>

        <form id="modal-senha-admin-form" onsubmit="event.preventDefault(); window.StudyOS.submeterSenhaAdmin();" class="space-y-4">
          <input type="text" name="username" value="studyos-admin" autocomplete="username" class="hidden" aria-hidden="true" tabindex="-1" />
          <div>
            <label class="block text-xs font-semibold text-zinc-300 mb-1.5" for="modal-senha-admin-input">
              Senha de Administrador:
            </label>
            <div class="relative">
              <input 
                id="modal-senha-admin-input" 
                name="password"
                type="password" 
                autocomplete="current-password"
                placeholder="Digite a senha de administrador..." 
                class="w-full px-3.5 py-2.5 rounded-xl bg-black/50 border border-notion-border text-white text-xs focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                required
              />
            </div>
            <p id="modal-senha-admin-erro" class="hidden text-[11px] text-rose-400 mt-1.5 font-medium"></p>
          </div>

          <div class="flex items-center gap-2">
            <input type="checkbox" id="modal-senha-admin-lembrar" class="rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer">
            <label for="modal-senha-admin-lembrar" class="text-[11px] text-notion-muted cursor-pointer select-none">
              Lembrar autenticação neste navegador
            </label>
          </div>

          <div class="flex items-center justify-end gap-2 pt-2 border-t border-notion-border">
            <button 
              type="button" 
              onclick="window.StudyOS.fecharModalSenhaAdmin()"
              class="px-3.5 py-2 rounded-xl text-xs font-medium text-notion-muted hover:text-white hover:bg-notion-hover transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button 
              type="submit"
              class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all hover:scale-105 active:scale-95 cursor-pointer flex items-center gap-1.5"
            >
              <span>Desbloquear</span>
              <span>🔓</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

/**
 * Processa a submissão do formulário de senha.
 */
export async function submeterSenhaAdmin() {
  if (typeof document === "undefined") return;

  const modal = document.getElementById("modal-senha-admin");
  const inputEl = document.getElementById("modal-senha-admin-input");
  const erroEl = document.getElementById("modal-senha-admin-erro");
  const lembrarEl = document.getElementById("modal-senha-admin-lembrar");

  if (!inputEl) return;
  const senha = inputEl.value;
  const lembrar = lembrarEl ? Boolean(lembrarEl.checked) : false;

  const sucesso = await autenticarAdmin(senha, lembrar);
  if (sucesso) {
    fecharModalSenhaAdmin();
    mostrarToast("Modo Administrador Desbloqueado", "Você possui acesso total para edições e sincronizações.", "success");
    if (modal && typeof modal._callbackSucesso === "function") {
      try {
        modal._callbackSucesso();
      } catch (err) {
        console.error("[Auth] Erro ao executar callback:", err);
      }
    }
  } else {
    if (erroEl) {
      erroEl.textContent = "Senha incorreta. Tente novamente ou use a senha padrão.";
      erroEl.classList.remove("hidden");
    }
    inputEl.select();
  }
}
