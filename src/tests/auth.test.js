import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { 
  calcularSha256, 
  autenticarAdmin, 
  desautenticarAdmin, 
  isAdminAutenticado, 
  alterarSenhaAdmin,
  gerenciarFirebaseSecret,
  getFirebaseParamAuth 
} from "../services/auth.js";

describe("Authentication & Admin Governance Suite", () => {
  beforeEach(() => {
    desautenticarAdmin();
  });

  it("deve calcular hash SHA-256 consistente", async () => {
    const hash = await calcularSha256("admin");
    assert.equal(typeof hash, "string");
    assert.equal(hash.length, 64);
  });

  it("deve iniciar como visitante (não autenticado)", () => {
    assert.equal(isAdminAutenticado(), false);
  });

  it("deve rejeitar senha incorreta", async () => {
    const ok = await autenticarAdmin("senha_errada_123");
    assert.equal(ok, false);
    assert.equal(isAdminAutenticado(), false);
  });

  it("deve autenticar com senha padrão mestre e permitir logout", async () => {
    const ok = await autenticarAdmin("studyos@admin");
    assert.equal(ok, true);
    assert.equal(isAdminAutenticado(), true);

    desautenticarAdmin();
    assert.equal(isAdminAutenticado(), false);
  });

  it("deve gerar parâmetro auth do Firebase quando secret estiver configurado", () => {
    gerenciarFirebaseSecret("meu_secret_firebase_123");
    const param = getFirebaseParamAuth();
    assert.equal(param, "?auth=meu_secret_firebase_123");

    gerenciarFirebaseSecret("");
    assert.equal(getFirebaseParamAuth(), "");
  });

  it("deve ocultar avisos de falta de mídia para visitantes e exibir somente para admin", async () => {
    const { criarAvisoFaltaItemHtml } = await import("../components/LessonAccordion.js");
    
    // Visitante (não autenticado): não deve exibir nenhum banner de falta
    assert.equal(isAdminAutenticado(), false);
    const avisoVisitante = criarAvisoFaltaItemHtml("🎬", "Falta Vídeo", "Nenhum vídeo", "bg-purple-500/10");
    assert.equal(avisoVisitante, "");

    // Admin autenticado: deve exibir o alerta para auditoria
    await autenticarAdmin("admin");
    assert.equal(isAdminAutenticado(), true);
    const avisoAdmin = criarAvisoFaltaItemHtml("🎬", "Falta Vídeo", "Nenhum vídeo", "bg-purple-500/10");
    assert.ok(avisoAdmin.includes("⚠️ Falta Vídeo"));
    assert.ok(avisoAdmin.includes("Ausente na Aula"));
  });

  it("deve ocultar o bloco 7 de Material Bruto para visitantes (proteção de direitos autorais) e exibir apenas para Admin", async () => {
    const { montarConteudoInternoDaAula } = await import("../components/LessonAccordion.js");
    const discMock = { id: "disc_1", nome: "Algoritmos" };
    const aulaMock = {
      id: "aula_1",
      nome: "Aula 01",
      arquivos: [
        { id: "md_1", nome: "Aula 01.md", tipo: "md", conteudoTexto: "# Aula 01\nConteúdo teste" }
      ]
    };

    // Modo Visitante: NÃO deve exibir Material Bruto
    desautenticarAdmin();
    assert.equal(isAdminAutenticado(), false);
    const htmlVisitante = montarConteudoInternoDaAula(discMock, aulaMock);
    assert.equal(htmlVisitante.includes("Material Bruto Utilizado na Aula"), false);

    // Modo Admin: DEVE exibir Material Bruto
    await autenticarAdmin("admin");
    assert.equal(isAdminAutenticado(), true);
    const htmlAdmin = montarConteudoInternoDaAula(discMock, aulaMock);
    assert.equal(htmlAdmin.includes("Material Bruto Utilizado na Aula"), true);
  });
});

