# Anubis

Aplicativo desktop local para orquestrar tarefas de desenvolvimento, com execução serial por projeto. O estado atual do repositório corresponde à **Fase 1**: shell Electron seguro e cadastro de projetos locais.

> A integração com Claude, brainstorm, fila e execução de tasks ainda não fazem parte desta fase.

## Pré-requisitos no Windows

Instale:

- [Git for Windows](https://git-scm.com/download/win);
- [Node.js 22 LTS](https://nodejs.org/) com npm;
- Windows 10 ou 11 em 64 bits.

Confirme em um PowerShell novo:

```powershell
git --version
node --version
npm --version
```

O comando `node --version` deve mostrar `v22` ou uma versão compatível posterior.

## Executar em modo de desenvolvimento

No PowerShell:

```powershell
git clone <URL-DO-REPOSITORIO> Anubis
cd Anubis
npm install
npm run dev
```

O `electron-vite` compila os processos main/preload e abre a janela do Electron com hot reload no renderer. Para encerrar, feche a janela ou pressione `Ctrl+C` no terminal.

Se você já possui o repositório clonado:

```powershell
cd C:\caminho\para\Anubis
git pull
npm install
npm run dev
```

## Verificações antes de desenvolver

Execute toda a validação disponível:

```powershell
npm run check
```

Esse comando executa, nesta ordem:

1. `npm run typecheck` — valida os tipos TypeScript;
2. `npm test` — executa testes unitários e de integração com Vitest;
3. `npm run build` — produz o build Electron em `out/`.

Também é possível executar cada etapa separadamente:

```powershell
npm run typecheck
npm test
npm run build
```

## Executar o build local

Depois do build:

```powershell
npm run build
npm run preview
```

Isso permite validar o build local. A geração de um instalador `.exe`/MSIX ainda não foi configurada na Fase 1.

## Uso da tela de projetos

1. Clique em **Add project**.
2. Informe um nome.
3. Clique em **Browse** e escolha uma pasta local existente.
4. Confirme em **Add project**.
5. Use **Edit** para alterar o cadastro ou **Archive** para ocultá-lo sem remover os arquivos da pasta.

O diretório precisa ter permissão de leitura e escrita. O mesmo diretório físico não pode ser cadastrado duas vezes.

## Dados locais

O banco SQLite é criado automaticamente no diretório `userData` do Electron. No Windows, normalmente estará em:

```text
%APPDATA%\anubis\anubis.db
```

Para abrir a pasta rapidamente:

```powershell
explorer $env:APPDATA\anubis
```

Não edite o banco enquanto o aplicativo estiver aberto. Para reiniciar os dados durante o desenvolvimento, feche o Anubis e faça backup ou remova `anubis.db`, `anubis.db-wal` e `anubis.db-shm`.

## Problemas comuns

### `npm` não é reconhecido

Instale o Node.js 22 LTS e abra um novo PowerShell para atualizar o `PATH`.

### O download do Electron falha atrás de proxy corporativo

Configure o proxy conforme as regras da sua empresa antes do `npm install`:

```powershell
npm config set proxy http://usuario:senha@proxy:porta
npm config set https-proxy http://usuario:senha@proxy:porta
```

Não salve credenciais reais em arquivos versionados. Quando necessário, peça ao administrador os endereços do registry e do mirror de binários Electron permitidos pela organização.

### Erro de acesso ao cadastrar uma pasta

Escolha uma pasta pertencente ao seu usuário e verifique se ela não está somente leitura. Pastas protegidas do Windows, como `C:\Program Files`, não são recomendadas para projetos.

### A janela abre vazia

Encerre o processo, remova o build temporário e inicie novamente:

```powershell
Remove-Item -Recurse -Force out -ErrorAction SilentlyContinue
npm run dev
```

Se continuar, execute `npm run check` e inclua a saída completa ao reportar o problema.

## Scripts disponíveis

| Comando | Finalidade |
|---|---|
| `npm run dev` | Abre o Electron em desenvolvimento |
| `npm run typecheck` | Valida TypeScript sem gerar arquivos |
| `npm test` | Executa os testes com Vitest |
| `npm run build` | Gera o build em `out/` |
| `npm run preview` | Abre o build local para validação |
| `npm run check` | Executa typecheck, testes e build |

Consulte [`docs/technical-design.md`](docs/technical-design.md) para a arquitetura completa e [`docs/implementation-plan-phase-1.md`](docs/implementation-plan-phase-1.md) para o escopo implementado nesta fase.
