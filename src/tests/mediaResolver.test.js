import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolverFontesMidia,
  otimizarUrlCapa,
  revogarBlobsDaAula,
  revogarTodosBlobs
} from "../services/mediaResolver.js";

describe("MediaResolver & Asset Governance Suite", () => {
  it("deve resolver fontes de mídia com ID do Google Drive válido", () => {
    const arq = {
      nome: "Video Aula 01.mp4",
      local: "1_Semestre/AED/Aula_01/video.mp4",
      driveId: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
      tipo: "mp4"
    };

    const fontes = resolverFontesMidia(arq, "aula-123", "../CienciaComputacao");
    assert.equal(fontes.driveIdValido, "1AbCdEfGhIjKlMnOpQrStUvWxYz");
    assert.equal(fontes.urlDrivePreview, "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview");
    assert.equal(fontes.urlDriveDownload, "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz");
    assert.equal(fontes.urlDriveStream, "https://docs.google.com/uc?export=open&id=1AbCdEfGhIjKlMnOpQrStUvWxYz");
    assert.equal(fontes.temFonteValida, true);
  });

  it("deve descartar IDs de Drive inválidos (slugs, caminhos ou muito curtos)", () => {
    const arqInvalido = {
      nome: "Arquivo.pdf",
      local: "docs/arquivo.pdf",
      driveId: "docs-arquivo-pdf", // Não é um ID real do Drive
      tipo: "pdf"
    };

    const fontes = resolverFontesMidia(arqInvalido, "aula-999");
    assert.equal(fontes.driveIdValido, "");
    assert.equal(fontes.urlDrivePreview, "");
  });

  it("deve construir caminho local relativo codificado com segurança", () => {
    const arq = {
      nome: "Análise de Algoritmos.pdf",
      local: "1º Semestre/Estrutura de Dados/Análise de Algoritmos.pdf",
      tipo: "pdf"
    };

    const fontes = resolverFontesMidia(arq, "aula-aed", "../CienciaComputacao");
    assert.ok(fontes.urlLocalConfigurado.includes("%C3%A1"));
    assert.ok(fontes.urlLocalConfigurado.startsWith("../CienciaComputacao/"));
    assert.equal(fontes.temFonteValida, true);
  });

  it("deve otimizar URLs de capa do Unsplash com dimensões e compressão calibradas", () => {
    const unsplashUrl = "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80";
    const otimizada = otimizarUrlCapa(unsplashUrl);
    assert.ok(otimizada.includes("w=420"));
    assert.ok(otimizada.includes("q=70"));
  });

  it("deve substituir URLs expiradas da AWS/Notion por capa padrão do Unsplash", () => {
    const awsUrl = "https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/capa.jpg";
    const otimizada = otimizarUrlCapa(awsUrl);
    assert.ok(otimizada.includes("unsplash.com"));
  });

  it("deve revogar blobs sem lançar erros mesmo para identificadores inexistentes", () => {
    assert.doesNotThrow(() => {
      revogarBlobsDaAula("aula-inexistente");
      revogarTodosBlobs();
    });
  });
});
