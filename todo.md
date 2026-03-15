# TODO - DivePlay

## Versão Aplicativo (Desktop)
- [x] Garantir que a versão aplicativo seja um único executável sem instalação (Portable).
- [x] Garantir que não seja necessário privilégio de administrador para executar.
- [x] Configurar Tauri para gerar o executável portátil.
- [x] Implementar backend em Rust para streaming/transcoding de codecs.
- [x] Abstrair acesso ao sistema de arquivos (Web vs Desktop).

## Próximos Passos (Sidecars & Transcoding)
- [ ] **Preparar Binários Sidecar:**
    - Criar pasta `src-tauri/binaries`.
    - Adicionar `ffmpeg.exe` renomeado para `ffmpeg-x86_64-pc-windows-msvc.exe`.
    - Adicionar `ffprobe.exe` renomeado para `ffprobe-x86_64-pc-windows-msvc.exe`.
- [ ] **Configurar Tauri Sidecars:**
    - Adicionar `"externalBin": ["binaries/ffmpeg", "binaries/ffprobe"]` ao `tauri.conf.json`.
- [ ] **Atualizar Backend Rust:**
    - Alterar comandos `Command::new` para usar `app_handle.shell().sidecar("ffmpeg")`.
    - Garantir que o `ffprobe` sidecar seja usado para extrair metadados e faixas de áudio.
- [ ] **UI/UX:**
    - Refinar o seletor de trilhas de áudio.
    - Adicionar suporte a seleção de legendas embutidas (via FFmpeg/Sidecar).
- [ ] **Geral:**
    - Adicionar atalhos de teclado globais.

> **Nota:** O tamanho do executável final aumentará para ~80-100MB devido à inclusão dos codecs nativos.
