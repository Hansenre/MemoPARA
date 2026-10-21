# MemoPARA

Revisão espaçada com **FSRS** e organização **PARA**. É a nova versão do
[SuperMemo PARA App](https://github.com/Hansenre/SupermemoPARAapp), refeita do zero.

## O que mudou em relação ao app original

| | SuperMemo PARA App | MemoPARA |
|---|---|---|
| Algoritmo | intervalos fixos 3/10/30/60 dias + ajustes | **FSRS-5** (o do Anki moderno): estabilidade, dificuldade e chance de lembrar por cartão |
| Unidade de revisão | o resumo inteiro | a nota inteira **e** cada linha `pergunta :: resposta`, agendadas separadamente |
| Notas | arquivos + texto no banco | Markdown puro no vault PARA (abre no Obsidian), com id no front matter |
| Dependências | Express, Multer, better-sqlite3 (compilação nativa) | **nenhuma**: Node 22.13+ com `node:sqlite` embutido |
| Código | `server.js` com 5 mil linhas, `app.js` com 4,5 mil | módulos pequenos (`src/`, `public/js/views/`) e testes automatizados |
| Desktop | Tauri (precisa de Rust para compilar) | atalho que abre em janela própria do Edge/Chrome |

Mantido do original: PARA com subpastas, recordação ativa, metacognição (confiança
antes da resposta), alerta de ilusão de competência, palácio da memória (loci),
explorador de arquivos e backup/restauração.

## Rodar

```bash
npm start            # http://127.0.0.1:5060
npm test             # testes do FSRS, do vault e da API
npm run shortcut     # cria o atalho na Área de Trabalho
```

Instalação em outro computador: veja [INSTALAR.txt](INSTALAR.txt).

## Estrutura

```
src/fsrs.js        algoritmo FSRS-5
src/db.js          SQLite (node:sqlite) e migrações
src/vault.js       arquivos .md, front matter, flashcards, caminhos seguros
src/service.js     regras: notas, cartões, fila, revisão, painel, backup
src/server.js      HTTP (somente 127.0.0.1/::1), API JSON e arquivos estáticos
public/            interface (ES modules, sem build)
launcher/          atalho (VBS sem console), instalador do atalho, gerador de ícone
```

Variáveis opcionais: `MEMOPARA_DATA` (pasta do banco), `MEMOPARA_VAULT` (pasta das notas),
`MEMOPARA_PORT`.

## Atalhos de teclado

`Ctrl K` busca · `N` nova nota · `R` revisar · na revisão: `1`–`4` confiança,
`Espaço` mostra a resposta, depois `1`–`4` avalia (Esqueci/Difícil/Bom/Fácil) ·
`Ctrl S` salva no editor.
