import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Modals } from "../main.js";

describe("Modals & Dynamic Imports (Code Splitting) Suite", () => {
  it("deve carregar sob demanda o ImmersiveCinemaModal via dynamic import()", async () => {
    const cinemaModule = await Modals.loadCinema();
    assert.ok(cinemaModule !== null);
    assert.equal(typeof cinemaModule.abrirModalEscolhaPlaylist, "function");
    assert.equal(typeof cinemaModule.iniciarPlaylistModo, "function");
    assert.equal(typeof cinemaModule.fecharPlaylistImersiva, "function");
    assert.equal(typeof cinemaModule.avancarPlaylist, "function");
    assert.equal(typeof cinemaModule.retrocederPlaylist, "function");
    assert.equal(typeof cinemaModule.toggleZoomImagemPlaylist, "function");
    assert.equal(typeof cinemaModule.handleMouseMoveZoomPlaylist, "function");
  });

  it("deve carregar sob demanda o AtividadeModal via dynamic import()", async () => {
    const ativModule = await Modals.loadAtividade();
    assert.ok(ativModule !== null);
    assert.equal(typeof ativModule.abrirModalAtividade, "function");
    assert.equal(typeof ativModule.fecharModalAtividade, "function");
    assert.equal(typeof ativModule.salvarModalAtividade, "function");
    assert.equal(typeof ativModule.atualizarPreviewCalculoAtividade, "function");
  });

  it("deve carregar sob demanda o DisciplineMetaModal via dynamic import()", async () => {
    const metaModule = await Modals.loadDisciplineMeta();
    assert.ok(metaModule !== null);
    assert.equal(typeof metaModule.abrirModalEditarDisciplina, "function");
    assert.equal(typeof metaModule.fecharModalEditarDisciplina, "function");
    assert.equal(typeof metaModule.salvarModalEditarDisciplina, "function");
  });

  it("deve carregar sob demanda o DataAulaModal via dynamic import()", async () => {
    const dataModule = await Modals.loadDataAula();
    assert.ok(dataModule !== null);
    assert.equal(typeof dataModule.abrirModalDataAula, "function");
    assert.equal(typeof dataModule.fecharModalDataAula, "function");
    assert.equal(typeof dataModule.salvarModalDataAula, "function");
    assert.equal(typeof dataModule.abrirModalVisualizacaoAula, "function");
    assert.equal(typeof dataModule.fecharModalVisualizacaoAula, "function");
  });

  it("deve carregar sob demanda o ImportReportModal via dynamic import()", async () => {
    const reportModule = await Modals.loadImportReport();
    assert.ok(reportModule !== null);
    assert.equal(typeof reportModule.abrirModalRelatorioImportacao, "function");
    assert.equal(typeof reportModule.fecharModalRelatorioImportacao, "function");
  });

  it("deve carregar sob demanda o ArquivosReferenciasModal via dynamic import()", async () => {
    const arqsModule = await Modals.loadArquivosReferencias();
    assert.ok(arqsModule !== null);
    assert.equal(typeof arqsModule.abrirModalArquivosReferencias, "function");
    assert.equal(typeof arqsModule.fecharModalArquivosReferencias, "function");
  });

  it("deve coletar itens corretos para a playlist imersiva por tipo de mídia", async () => {
    const { coletarItensPlaylist } = await Modals.loadCinema();

    const mockDisc = {
      aulas: [
        {
          id: "aula-1",
          nome: "Aula 01",
          arquivos: [
            { nome: "foto1.jpg", tipo: "jpg", local: "f1.jpg" },
            { nome: "foto2.png", tipo: "png", local: "f2.png" },
            { nome: "aula.mp4", tipo: "mp4", local: "v.mp4" },
            { nome: "slides.pdf", tipo: "pdf", temOCR: false, local: "s.pdf" },
            { nome: "podcast.m4a", tipo: "m4a", local: "p.m4a" }
          ]
        }
      ]
    };

    const imgs = coletarItensPlaylist(mockDisc, "img");
    assert.equal(imgs.length, 2);

    const vids = coletarItensPlaylist(mockDisc, "video");
    assert.equal(vids.length, 1);
    assert.equal(vids[0].nome, "aula.mp4");

    const pdfs = coletarItensPlaylist(mockDisc, "pdf");
    assert.equal(pdfs.length, 1);
    assert.equal(pdfs[0].nome, "slides.pdf");

    const audios = coletarItensPlaylist(mockDisc, "audio");
    assert.equal(audios.length, 1);
    assert.equal(audios[0].nome, "podcast.m4a");
  });

  it("deve executar renderAtividadesDisciplina com segurança sem ReferenceError", async () => {
    const { renderAtividadesDisciplina } = await import("../main.js");
    // Mock leve do DOM para simular a presença dos elementos
    global.document = {
      getElementById: (id) => {
        return {
          textContent: "",
          innerHTML: "",
          classList: { remove: () => {}, add: () => {} },
          appendChild: () => {}
        };
      }
    };

    assert.doesNotThrow(() => {
      renderAtividadesDisciplina({ id: "disc-teste", nome: "Teste", atividades: [{ nome: "P1", status: "Concluído", nota: 10 }] });
      renderAtividadesDisciplina({ id: "disc-vazia", nome: "Sem Ativs" });
    });
  });

  it("deve renderizar renderDisciplinesDatabase no modo table sem ReferenceError", async () => {
    const { renderDisciplinesDatabase } = await import("../main.js");
    const { store } = await import("../core/store.js");

    const gridEl = { innerHTML: "" };
    const counterEl = { textContent: "" };
    const activeBarEl = { classList: { add: () => {}, remove: () => {} } };
    const activeChipsEl = { innerHTML: "" };

    global.document = {
      getElementById: (id) => {
        if (id === "disciplines-grid") return gridEl;
        if (id === "db-filtered-counter") return counterEl;
        if (id === "active-filters-bar") return activeBarEl;
        if (id === "active-filters-chips") return activeChipsEl;
        return null;
      }
    };

    store.setState({
      databaseViewMode: "table",
      filtroSemestreAtivo: "todos",
      filtroStatusAtivo: "todos",
      filtroTagAtiva: "todas",
      filtroTextoInline: "",
      db: {
        semestres: [
          {
            id: "1-sem",
            nome: "1° semestre",
            disciplinas: [
              {
                id: "algoritmos",
                nome: "Algoritmos",
                icone: "💻",
                prof: "Prof. Teste",
                status: "Em andamento",
                TAGS: ["2026"],
                atividades: [{ nome: "P1", status: "A fazer" }],
                aulas: [{ id: "a1", nome: "Aula 01", data_aula: "2026-03-01", presenca: true }]
              }
            ]
          }
        ]
      }
    });

    assert.doesNotThrow(() => {
      renderDisciplinesDatabase();
    });
    assert.ok(gridEl.innerHTML.includes("<table"));
    assert.ok(gridEl.innerHTML.includes("Algoritmos"));
  });
});
