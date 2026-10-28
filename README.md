# MusicaMP3

PWA (app web instalável) para **buscar, baixar e ouvir músicas de licença livre**, com visual inspirado em apps de download de música.

| Aba | O que faz |
|---|---|
| **Baixar** | Busca no YouTube (toca no player oficial, sem download), no Internet Archive e no Jamendo |
| **Lista de músicas** | Cole "Artista - Música" (uma por linha): o app acha cada uma na biblioteca ou no YouTube, toca tudo em sequência e salva como playlist |
| **Reproduzir** | Biblioteca offline (IndexedDB) + importação de arquivos do aparelho |
| **Configurações** | Client ID do Jamendo, tema, uso de armazenamento |

O player tem fila, aleatório, repetir e controles na tela de bloqueio (Media Session).

## Fontes

- **YouTube**: precisa de uma chave grátis da YouTube Data API v3 (cerca de 100 buscas por dia). Os vídeos tocam no player oficial embutido, que fica sempre visível; não há download. As buscas da lista ficam em cache para economizar cota.
- **Internet Archive**: filtra itens com licença Creative Commons, netlabels e shows ao vivo liberados (etree).
- **Jamendo**: crie um Client ID grátis em <https://devportal.jamendo.com/> e cole em *Configurações*. Só baixa faixas com `audiodownload_allowed`.

## Rodar localmente

```bash
cd public
python3 -m http.server 8000
# abra http://localhost:8000
```

## Publicar (GitHub Pages)

1. No GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Faça merge na `main`. O workflow `.github/workflows/pages.yml` publica a pasta `public/`.
3. No celular, abra o link e use **"Adicionar à tela inicial"**.

Sem build e sem dependências: HTML, CSS e JS puros.
