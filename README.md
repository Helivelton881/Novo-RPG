# MMORPG: Vila Inicial — multiplayer MVP

Este projeto adiciona presença multiplayer real ao protótipo existente.

## Incluído

- servidor HTTP e WebSocket;
- jogadores remotos no mesmo mapa;
- posição, direção, animação, classe e nível sincronizados;
- entrada, saída e reconexão;
- contador de jogadores online;
- validação básica e heartbeat no servidor.

O combate, os monstros, o inventário e o progresso ainda são calculados pelo cliente. Eles precisam migrar para o servidor antes de uma versão pública competitiva.

## Executar

```powershell
npm install
npm start
```

Abra `http://localhost:8080` em dois navegadores ou dispositivos da mesma rede.

Para publicar, configure `PORT` na hospedagem e use um serviço compatível com WebSocket.
