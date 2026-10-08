# Horizonte Voxel — jogo de sobrevivência espacial voxel (título provisório)

Jogo 3D de sobrevivência, exploração espacial e construção voxel que roda no navegador
(HTML5 + TypeScript + Three.js/WebGL2). Direção de arte interna: **Voxel Realism** —
geometria em blocos com materiais PBR e luz fisicamente plausível.

## Como rodar

```bash
npm install
npm run dev      # servidor de desenvolvimento (http://localhost:5173)
npm run build    # typecheck + build de produção em dist/
npm run preview  # serve o build de produção
```

Requer um navegador com WebGL2 (Chrome/Edge/Firefox recentes). Uma GPU dedicada é
recomendada para os presets Alto/Ultra/Cinematográfico.

## Controles

| Tecla | Ação |
| --- | --- |
| W A S D / Mouse | mover / olhar (na nave: o mouse pilota) |
| Shift | correr · pós-combustor |
| Espaço | saltar · nadar · jetpack (segurar no ar) · subir (nave) |
| C / Ctrl | descer (água, nave) |
| Clique esquerdo / direito | usar ferramenta / ação secundária |
| 1–9, roda do mouse | barra de acesso rápido |
| E | interagir · entrar/sair da nave |
| R | painel de reparos (a pé) · ligar motores (cockpit) |
| TAB | terminal (inventário, fabricação, construção, traje, nave, diário, mapas) |
| F | lanterna · V câmera 1ª/3ª pessoa (cockpit/externa) |
| M / G | mapa do sistema / mapa galáctico |
| Q/E, X, Z, T, B, L, J | rolagem, trem de pouso, assistência, cruzeiro, freio, farol, salto |

## Arquitetura

```
src/
  core/        rng determinístico, ruído simplex/tileável, input, configurações
  universe/    galáxia por setores, gerador de sistemas estelares, tipos planetários,
               órbitas e referenciais (StarSystem)
  planet/      mapeamento cube-sphere, gerador de terreno, LOD quadtree, tiles/bakes
  voxel/       blocos, paleta PBR, greedy mesher, worker, streaming de chunks (VoxelWorld)
  physics/     colisão e raycast no espaço de grade da esfera cúbica
  render/      pipeline HDR, composição atmosfera/oceano/nuvens, pós-processo,
               céu, estrela, corpos distantes, materiais de terreno, texturas procedurais
  player/      astronauta voxel (rig + animação procedural)
  ship/        modelo e física da nave
  game/        Game (orquestração), Universe, Player, Pilot, Effects, Fauna, Tools
  survival/    sinais vitais; weather/ clima; items/ inventário e receitas
  building/    módulos de base, rede elétrica, pressurização de habitat
  audio/       motor de áudio 100% procedural (Web Audio)
  save/        salvamento versionado em IndexedDB (deltas RLE de chunks)
  campaign/    sequência inicial de objetivos
  ui/          HUD, menus, terminal e mapas
```

### Decisões técnicas principais

- **Planetas esféricos voxel (cube-sphere equiangular).** Cada planeta tem 6 faces com
  `N×N` colunas e 512 camadas radiais. Os voxels ficam sempre alinhados ao "para cima"
  local, então o jogador caminha sobre blocos planos em qualquer ponto do planeta.
- **Colisão no espaço de grade.** Deslocamentos do mundo são mapeados pela jacobiana
  local para o espaço `(face, x, y, z)`, onde cada voxel é um cubo unitário e `+z` é
  radial — colisões AABB robustas sobre superfícies curvas, com subida automática de
  degraus. Por isso não foi usado um motor de física genérico (Rapier): ele não traria
  vantagem sobre colisão voxel exata e exigiria reconstruir malhas de colisão a cada edição.
- **Determinismo.** Galáxia, sistemas, planetas, minérios, flora, estruturas e espécies
  derivam de sementes (`hash32`). Só as modificações do jogador são salvas.
- **Streaming assíncrono.** Workers geram chunks, fazem o greedy meshing (fusões
  limitadas a 8 células para manter as arestas fiéis à curvatura), tiles de LOD e
  texturas. O LOD distante é descartado dentro do raio coberto por voxels já carregados.
- **Precisão / floating origin.** Simulação em doubles (JS) em referenciais locais: o
  referencial co-rotativo do corpo onde o jogador está, ou o referencial do sistema.
  A câmera fica sempre na origem do espaço de renderização; tudo é posicionado em
  relação a ela na CPU. Profundidade logarítmica cobre de 5 cm a 200 000 km.
- **Atmosfera e oceano num único passe de composição** (Rayleigh + Mie com sombra
  planetária, oceano analítico com ondas, refração/absorção, espuma, reflexo do céu,
  camada de nuvens com sombras projetadas, neblina subaquática), seguido de
  autoexposição, bloom, tonemapping ACES, color grading e FXAA.

## Estado atual

Vertical slice jogável cobrindo as fases 1–5 do plano, com polimento visual em andamento.

| Fase | Conteúdo | Estado |
| --- | --- | --- |
| 1 | Pipeline HDR, planeta cube-sphere com LOD, chunks editáveis, astronauta, câmeras 1ª/3ª pessoa | ✅ |
| 2 | Sobrevivência (O₂, energia, temperatura, integridade, radiação, fome/sede no modo completo), mineração, inventário, fabricação, módulos de base com energia e pressurização | ✅ |
| 3 | Nave pilotável: reparo, decolagem, voo atmosférico, órbita, pouso, aquecimento de reentrada | ✅ |
| 4 | Sistema estelar completo: viagem interplanetária em cruzeiro, troca de referencial por esfera de influência, estação orbital com acoplamento, cinturão de asteroides | ✅ |
| 5 | Galáxia procedural por setores, salto interestelar, chegada em sistemas novos | ✅ |
| 6 | Polimento de realismo, desempenho e conteúdo | 🔄 em andamento |

Também implementados: menu principal cinematográfico em 3D, campanha inicial guiada
(acordar → escanear → coletar → fabricar → reparar → energia → propulsor → embarcar →
órbita → identificar → viajar → salto), clima dinâmico (chuva, tempestade, neve,
nevasca, tempestade de areia), ciclo dia/noite com eclipses, fauna e flora procedurais por
planeta, pontos de interesse (postos, destroços, monólitos) com saque e registros,
scanner, diário de descobertas, renomeação de corpos, personalização do traje, áudio e
música procedurais adaptativos, salvamento versionado e configurações gráficas com presets
(Baixo, Médio, Alto, Ultra, Cinematográfico) e controles individuais.

### Testes

Os fluxos principais são verificados com scripts Playwright (Chromium/SwiftShader):
novo jogo, caminhada, mineração, fabricação, reparo, decolagem, órbita, viagem e pouso em
outra lua, pressurização de habitat, salto interestelar, salvar → recarregar → continuar,
todas as abas do terminal, visita a cada tipo de planeta e fauna. Em CPU, um passo de
simulação custa ~1 ms; a cena típica na superfície fica em ~1 M triângulos / ~400 draw calls.

### Próximos passos

- Mais variedade de biomas, estruturas e espécies; árvore tecnológica mais longa.
- Otimizações de GPU para os presets altos (oclusão de chunks, instancing de flora).
- Anéis e luas com superfícies pousáveis em sistemas gerados; mais tipos de estação.
