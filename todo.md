# TODO

## FFmpeg Binary Resolution - Análise e Plano

### O Problema
O FFmpeg/FFprobe não é encontrado em modo dev e produção porque:
1. O `resources` do Tauri não está sendo bundlado corretamente
2. Os caminhos de fallback não cobrem todos os cenários

### Opções Considered

| Opção | Prós | Contras |
|-------|------|---------|
| **1. Sidecar (Tauri native)** | Maneira correta do Tauri | Configuração complexa |
| **2. Embed como base64** | Sempre funciona | +100MB no binário, startup lento |
| **3. Download runtime** | Binário pequeno inicial | Requer internet |
| **4. Bundler correto** | Solução mais limpa | Requerdebugar o bundling |
| **5. Rust built-in** | Sem dependências externas | FFmpeg huge para compilar |

### Plano de Execução (Dividido em partes)

---

## Parte 1: Adicionar Visualização de Logs na App (Concluído)
- [x] Adicionar atalho de teclado (L) para abrir logs
- [x] Exibir logs do backend (Rust) no frontend
- [x] Criar dialog/modal de logs na interface
- [x] Sistema de logging no Rust com buffer

## Como Testar os Logs
1. Execute `npx tauri dev` ou rode o .exe
2. Pressione **L** para abrir o painel de logs
3. Tente reproduzir um arquivo MKV para ver os logs de busca do FFmpeg
4. Os logs mostram cada caminho que está sendo verificado

## Parte 2: Diagnosticar o Bundling (Em Andamento)
- [ ] Verificar onde os recursos estão sendo copiados no build
- [ ] Testar se `resources` está funcionando no tauri.conf.json
- [ ] Adicionar logs mais detalhados no Rust para debug

## Parte 3: Corrigir o Caminho
- [ ] Usar o caminho correto baseado no diagnóstico
- [ ] Garantir que funcione em todos os cenários

---

## Tarefas Separadas

- [ ] Add support for dragging and dropping files directly onto the player.
- [ ] Implement a search bar for the playlist.
- [ ] Add more themes/skins.
- [ ] Improve subtitle synchronization options.