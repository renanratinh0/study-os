import csv
import json
import re
import unicodedata
from pathlib import Path

# ============================================================
# CONFIGURAÇÕES
# ============================================================

CAMINHO_DRIVE = Path(r"G:\Meu Drive\CienciaComputacao")

# Procura o banco no diretório atual ou na pasta deste script.
PASTA_SCRIPT = Path(__file__).resolve().parent

CANDIDATOS_DB = [
    Path("db.personal.json"),
    PASTA_SCRIPT / "db.personal.json",
]

DB_PATH = next(
    (p.resolve() for p in CANDIDATOS_DB if p.exists()),
    PASTA_SCRIPT / "db.personal.json",
)

RELATORIO_CSV = PASTA_SCRIPT / "relatorio_auditoria_aulas.csv"

# Extensões aceitas para cada tipo de material.
EXTENSOES = {
    "MD": {".md", ".markdown"},
    "JSON": {".json"},
    "JPG": {".jpg", ".jpeg"},
    "PNG": {".png"},
    "PDF": {".pdf"},
    "MP4": {".mp4"},
    "AUDIO": {".m4a", ".mp4a"},
}


def normalizar_nome_classificacao(nome_arquivo):
    """Remove acentos e normaliza nome de arquivo para classificação estrita."""
    sem_acento = "".join(
        c for c in unicodedata.normalize("NFD", str(nome_arquivo or ""))
        if unicodedata.category(c) != "Mn"
    )
    return Path(sem_acento.strip()).name.lower()


def classificar_artefato_arquivo(nome_arquivo):
    """
    Classifica arquivos com prioridade estrita por nome (case-insensitive):
      - *mapa-mental.json -> 'MAPA_MENTAL'
      - *flashcards.md    -> 'FLASHCARDS'
      - *quiz.md          -> 'QUIZ'
      - *relatorio.md     -> 'RELATORIO'
      - qualquer outro .md -> 'MD' (Camada 1)
    """
    nome_norm = normalizar_nome_classificacao(nome_arquivo)
    if nome_norm.endswith("mapa-mental.json"):
        return "MAPA_MENTAL"
    if nome_norm.endswith("flashcards.md"):
        return "FLASHCARDS"
    if nome_norm.endswith("quiz.md"):
        return "QUIZ"
    if nome_norm.endswith("relatorio.md"):
        return "RELATORIO"
    if Path(nome_norm).suffix in EXTENSOES["MD"]:
        return "MD"
    return None

CATEGORIAS_OBRIGATORIAS = {
    "MD": "md",
    "JPG": "JPG",
    "PNG": "PNG",
    "PDF_SEM_OCR": "PDF sem OCR",
    "PDF_COM_OCR": "PDF com OCR",
    "MP4": "MP4",
    "AUDIO": "Áudio M4A/MP4A",
}

# ============================================================
# NORMALIZAÇÃO E LEITURA DO DB
# ============================================================

def normalizar_texto(texto):
    """Normaliza nomes para facilitar a identificação das aulas."""
    texto = unicodedata.normalize("NFD", str(texto or ""))
    texto = "".join(
        c for c in texto
        if unicodedata.category(c) != "Mn"
    )
    return texto.lower().strip()


def normalizar_caminho(caminho):
    """Padroniza caminhos para comparar os arquivos com o DB."""
    texto = unicodedata.normalize("NFC", str(caminho or ""))
    return texto.replace("\\", "/").strip("/").casefold()


def carregar_db():
    if not CAMINHO_DRIVE.exists():
        raise FileNotFoundError(
            f"Google Drive não encontrado: {CAMINHO_DRIVE}"
        )

    if not DB_PATH.exists():
        raise FileNotFoundError(
            f"Banco não encontrado: {DB_PATH}\n"
            "Execute primeiro o gerador do db.personal.json."
        )

    with DB_PATH.open("r", encoding="utf-8-sig") as arquivo:
        dados = json.load(arquivo)

    if not isinstance(dados, dict) or not isinstance(
        dados.get("filhos"), list
    ):
        raise ValueError(
            "O JSON não parece ter a estrutura esperada do Study OS."
        )

    return dados


def percorrer_arvore(no):
    """Percorre recursivamente todos os nós do db.json."""
    if not isinstance(no, dict):
        return

    yield no

    for filho in no.get("filhos", []):
        yield from percorrer_arvore(filho)


def criar_indice_ocr(db):
    """
    Reaproveita a classificação OCR salva pelo gerador do DB.
    Evita reprocessar todos os PDFs do zero.
    """
    indice = {}

    for no in percorrer_arvore(db):
        if no.get("tipo") != "arquivo":
            continue

        nome = no.get("nome", "")
        local = no.get("local", "")

        if Path(nome).suffix.lower() != ".pdf":
            continue

        chave = normalizar_caminho(local)

        if "temOCR" in no:
            valor = no["temOCR"]
            if isinstance(valor, bool):
                indice[chave] = valor
            elif str(valor).strip().lower() in {"true", "1", "sim", "yes"}:
                indice[chave] = True
            elif str(valor).strip().lower() in {"false", "0", "nao", "não", "no"}:
                indice[chave] = False

        elif no.get("statusOCR") == "com_ocr":
            indice[chave] = True

        elif no.get("statusOCR") == "sem_ocr":
            indice[chave] = False

    return indice


# ============================================================
# CLASSIFICAÇÃO OCR DE RESERVA
# ============================================================

def detectar_ocr_pdf(caminho_pdf):
    """
    Analisa se há texto extraível nas primeiras 5 páginas caso não conste no DB.
    """
    try:
        import fitz  # PyMuPDF

        with fitz.open(caminho_pdf) as documento:
            texto = ""
            for pagina in documento.pages[:5]:
                texto += pagina.get_text("text") or ""
                if len(re.sub(r"\s+", "", texto)) >= 25:
                    return True

        return len(re.sub(r"\s+", "", texto)) >= 25

    except ImportError:
        pass
    except Exception:
        pass

    try:
        from pypdf import PdfReader

        leitor = PdfReader(str(caminho_pdf), strict=False)
        texto = ""
        for pagina in leitor.pages[:5]:
            try:
                texto += pagina.extract_text() or ""
            except Exception:
                continue

            if len(re.sub(r"\s+", "", texto)) >= 25:
                return True

        return len(re.sub(r"\s+", "", texto)) >= 25

    except ImportError:
        pass
    except Exception:
        pass

    try:
        from PyPDF2 import PdfReader

        leitor = PdfReader(str(caminho_pdf), strict=False)
        texto = ""
        for pagina in leitor.pages[:5]:
            try:
                texto += pagina.extract_text() or ""
            except Exception:
                continue

            if len(re.sub(r"\s+", "", texto)) >= 25:
                return True

        return len(re.sub(r"\s+", "", texto)) >= 25

    except Exception:
        return None


def obter_classificacao_pdf(caminho_pdf, indice_ocr):
    """Consulta primeiro o índice em memória e, se necessário, inspeciona o arquivo."""
    relativo = caminho_pdf.relative_to(CAMINHO_DRIVE).as_posix()
    chave = normalizar_caminho(relativo)

    if chave in indice_ocr:
        return indice_ocr[chave]

    return detectar_ocr_pdf(caminho_pdf)


# ============================================================
# IDENTIFICAÇÃO E AUDITORIA FÍSICA
# ============================================================

def eh_pasta_aula(no):
    """Identifica pastas no padrão Aula XX."""
    if no.get("tipo") != "pasta":
        return False

    nome = normalizar_texto(no.get("nome", ""))
    return nome.startswith("aula")


def auditar_aula(caminho_aula, indice_ocr):
    contagens = {
        "MD": 0,
        "JPG": 0,
        "PNG": 0,
        "PDF_SEM_OCR": 0,
        "PDF_COM_OCR": 0,
        "MP4": 0,
        "AUDIO": 0,
        "PDF_NAO_CLASSIFICADO": 0,
        "MAPA_MENTAL": 0,
        "FLASHCARDS": 0,
        "QUIZ": 0,
        "RELATORIO": 0,
    }

    arquivos = [
        arquivo
        for arquivo in caminho_aula.rglob("*")
        if arquivo.is_file()
        and arquivo.name.lower() not in ("desktop.ini", "thumbs.db")
        and not arquivo.name.startswith(".")
    ]

    for arquivo in arquivos:
        extensao = arquivo.suffix.lower()
        role_artefato = classificar_artefato_arquivo(arquivo.name)

        if role_artefato == "MAPA_MENTAL":
            contagens["MAPA_MENTAL"] += 1

        elif role_artefato == "FLASHCARDS":
            contagens["FLASHCARDS"] += 1

        elif role_artefato == "QUIZ":
            contagens["QUIZ"] += 1

        elif role_artefato == "RELATORIO":
            contagens["RELATORIO"] += 1

        elif role_artefato == "MD":
            contagens["MD"] += 1

        elif extensao in EXTENSOES["JPG"]:
            contagens["JPG"] += 1

        elif extensao in EXTENSOES["PNG"]:
            contagens["PNG"] += 1

        elif extensao in EXTENSOES["MP4"]:
            contagens["MP4"] += 1

        elif extensao in EXTENSOES["AUDIO"]:
            contagens["AUDIO"] += 1

        elif extensao == ".pdf":
            tem_ocr = obter_classificacao_pdf(arquivo, indice_ocr)

            if tem_ocr is True:
                contagens["PDF_COM_OCR"] += 1
            elif tem_ocr is False:
                contagens["PDF_SEM_OCR"] += 1
            else:
                contagens["PDF_NAO_CLASSIFICADO"] += 1

    return contagens


# ============================================================
# EXECUÇÃO E SAÍDA FOCADA EM PENDÊNCIAS
# ============================================================

def executar_auditoria():
    db = carregar_db()
    indice_ocr = criar_indice_ocr(db)

    resultados = []
    total_aulas = 0
    total_aulas_completas = 0

    print("=" * 80)
    print("AUDITORIA — PENDÊNCIAS ENCONTRADAS")
    print("=" * 80)

    for semestre in db.get("filhos", []):
        nome_semestre = semestre.get("nome", "")

        for materia in semestre.get("filhos", []):
            nome_materia = materia.get("nome", "")

            for aula in materia.get("filhos", []):
                if not eh_pasta_aula(aula):
                    continue

                local = aula.get("local", "")
                caminho_aula = CAMINHO_DRIVE.joinpath(
                    *str(local).replace("\\", "/").split("/")
                )

                if not caminho_aula.is_dir():
                    continue

                contagens = auditar_aula(caminho_aula, indice_ocr)

                faltando = [
                    descricao
                    for chave, descricao in CATEGORIAS_OBRIGATORIAS.items()
                    if contagens[chave] == 0
                ]

                total_aulas += 1

                if not faltando:
                    total_aulas_completas += 1
                    status = "COMPLETA"
                else:
                    status = "INCOMPLETA"
                    # Exibição compacta focada em ação corretiva imediata
                    print(f"❌  {nome_semestre} / {nome_materia} / {aula['nome']}")
                    print(f"FALTANDO {', '.join(faltando)}\n")

                resultados.append({
                    "Semestre": nome_semestre,
                    "Materia": nome_materia,
                    "Aula": aula["nome"],
                    "Caminho": str(caminho_aula),
                    "MD": contagens["MD"],
                    "JPG": contagens["JPG"],
                    "PNG": contagens["PNG"],
                    "PDF sem OCR": contagens["PDF_SEM_OCR"],
                    "PDF com OCR": contagens["PDF_COM_OCR"],
                    "MP4": contagens["MP4"],
                    "Audio M4A ou MP4A": contagens["AUDIO"],
                    "Mapa Mental": contagens["MAPA_MENTAL"],
                    "Flashcards": contagens["FLASHCARDS"],
                    "Quiz": contagens["QUIZ"],
                    "Relatorio": contagens["RELATORIO"],
                    "PDFs nao classificados": contagens["PDF_NAO_CLASSIFICADO"],
                    "Materiais faltando": ", ".join(faltando),
                    "Status": status,
                })

    # Persistência estruturada em CSV
    colunas = [
        "Semestre",
        "Materia",
        "Aula",
        "Caminho",
        "MD",
        "JPG",
        "PNG",
        "PDF sem OCR",
        "PDF com OCR",
        "MP4",
        "Audio M4A ou MP4A",
        "Mapa Mental",
        "Flashcards",
        "Quiz",
        "Relatorio",
        "PDFs nao classificados",
        "Materiais faltando",
        "Status",
    ]

    with RELATORIO_CSV.open(
        "w", newline="", encoding="utf-8-sig"
    ) as arquivo_csv:
        escritor = csv.DictWriter(arquivo_csv, fieldnames=colunas)
        escritor.writeheader()
        escritor.writerows(resultados)

    print("=" * 80)
    print("RESUMO CONSOLIDADO")
    print(f"Aulas Analisadas : {total_aulas}")
    print(f"Aulas Completas  : {total_aulas_completas}")
    print(f"Aulas Pendentes  : {total_aulas - total_aulas_completas}")
    print(f"Log CSV Gerado   : {RELATORIO_CSV.name}")
    print("=" * 80)


if __name__ == "__main__":
    try:
        executar_auditoria()
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as erro:
        print(f"\n❌ ERRO DE CONFIGURAÇÃO OU ARQUIVO: {erro}")
    except PermissionError as erro:
        print(f"\n❌ ACESSO NEGADO: {erro}")                                        