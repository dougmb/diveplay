# Plano de Implementação: DivePlay Desktop (Tauri) + Web

## 1. Objetivo
Criar uma versão de aplicativo nativo (Windows, macOS, Linux) do DivePlay utilizando o framework **Tauri**, solucionando o problema de suporte a formatos de mídia e codecs comuns (MKV, HEVC, AC3, DTS) que os navegadores bloqueiam. Tudo isso mantendo a atual versão Web totalmente funcional e rodando a partir da mesma base de código React/Vite.

## 2. Arquitetura do Projeto (Coexistência)
O repositório funcionará como um **Monorepo lógico**, onde o Frontend é compartilhado e as capacidades do sistema variam com base no ambiente de execução.

*   **Versão Web (Navegador):** Continua usando a `File System Access API` para ler diretórios e o `codecService.ts` (com `ffmpeg.wasm`) para lidar com codecs não suportados via transcodificação no browser.
*   **Versão Desktop (Tauri):** Usa o backend em Rust, que é absurdamente mais leve que o Electron. Como o Tauri utiliza o WebView nativo do SO (Edge WebView2, WebKit, WebKitGTK), ele herda as limitações de codecs desses motores. Para resolver isso, utilizaremos o backend Rust para contornar o problema de reprodução sem depender do ffmpeg.wasm.

### 2.1 Estratégia para Reprodução de Codecs no Tauri
Como os WebViews nativos continuam não suportando nativamente codecs proprietários como HEVC ou áudio AC3 nos containers MKV, o Tauri precisa de uma ponte. A abordagem ideal para o aplicativo é:

**Streaming Server Local em Rust + FFmpeg Nativo (On-the-fly):**
Em vez de usar WebAssembly (lento e consome muita CPU), o backend do Tauri iniciará um servidor HTTP local super leve. Quando o usuário selecionar um arquivo não suportado, o backend Rust utilizará os binários nativos do sistema (ou empacotados junto com o app) do FFmpeg para fazer o "muxing/transcoding" instantâneo do vídeo para a porta local, entregando um stream `.m3u8` ou `.mp4` suportado perfeitamente pela tag `<video>`.
*Vantagem:* Muito mais rápido, suporta legendas embutidas perfeitamente, usa aceleração de hardware do SO.

## 3. Etapas de Implementação

### Fase 1: Configuração do Tauri
1.  **Instalação de Dependências:** Instalar `@tauri-apps/cli` e `@tauri-apps/api` no projeto Node.js.
2.  **Inicialização:** Executar a inicialização do Tauri para criar a pasta `src-tauri` contendo o backend em Rust.
3.  **Configuração de Scripts:** Atualizar o `package.json` para suportar comandos separados:
    *   `npm run dev` (Web)
    *   `npm run tauri dev` (Desktop)
    *   `npm run build:web`
    *   `npm run build:desktop`
4.  **Ajustes no Vite:** Garantir que o `vite.config.ts` seja compatível com a compilação do Tauri (geralmente sem problemas de integração).

### Fase 2: Abstração de Serviços (Web vs Desktop)
1.  **Detecção de Ambiente:** Criar um utilitário `isTauri()` verificando se o objeto `window.__TAURI__` existe.
2.  **File System Abstraction:**
    *   Atualizar o `FolderPicker.tsx` e `fileSystem.ts`.
    *   Se `isTauri()`, usar `@tauri-apps/plugin-dialog` para abrir o seletor nativo do sistema operacional e `@tauri-apps/plugin-fs` para listar os arquivos de forma extremamente rápida.
    *   Se Web, usar o fluxo atual do `showDirectoryPicker`.
3.  **Leitura de Arquivos de Mídia:**
    *   O Tauri exige que os arquivos do sistema sejam lidos com segurança. Usaremos um protocolo customizado (ex: `asset://localhost/C:/path/to/video.mp4`) providenciado pelo Tauri para contornar limitações de CORS, enviando o arquivo local direto para a tag `<video>`.

### Fase 3: Solução de Codecs (Backend Rust)
1.  Avaliar e implementar um mecanismo no Rust que intercepte arquivos problemáticos (como `.mkv` ou codecs de áudio incompatíveis).
2.  Integrar um fluxo de streaming: O Tauri possui plugins não oficiais ou abordagens comuns para streaming de arquivos de vídeo pesados via servidor web interno em Rust (`warp` ou `axum`), capaz de invocar ferramentas de conversão se necessário.
3.  *Alternativa:* Integrar o aplicativo via FFI com alguma biblioteca de media player no sistema (como GStreamer ou mpv), porém a transcodificação leve local para o WebView tende a dar a melhor experiência UI em React.

### Fase 4: Integração de UI / UX
1.  **Bordas da Janela:** Implementar a opção de janela "Frameless" (sem as bordas padrão do Windows/Mac) com controles customizados desenhados no React (Botões de Minimizar, Maximizar, Fechar) para um visual moderno e elegante.
2.  **Atalhos Globais:** Mesmo sem o Ctrl+O, configuraremos teclas de mídia de hardware (Play/Pause/Next/Prev do teclado) se possível, usando APIs do Tauri.

### Fase 5: Empacotamento e Distribuição
1.  Configurar o `tauri.conf.json` para definir ícones, identificadores de bundle (`com.diveplay.app`) e permissões de segurança essenciais.
2.  Criar workflows do GitHub Actions para compilar automaticamente instaladores:
    *   `.msi` e `.exe` para Windows.
    *   `.dmg` e `.app` para macOS.
    *   `.deb` e `.AppImage` para Linux.

## 4. Próximos Passos Imediatos
Se você estiver de acordo com este plano:
1.  Vou instalar e inicializar o Tauri no diretório atual.
2.  Farei a configuração inicial no `package.json` e Vite.
3.  Criaremos as abstrações para detecção do Tauri nas camadas de acesso aos arquivos para garantir que o código existente no navegador não quebre.