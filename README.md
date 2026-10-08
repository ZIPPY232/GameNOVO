# Horizonte — jogo de sobrevivência e exploração espacial (título provisório)

Jogo 3D de sobrevivência, exploração espacial e construção que roda no navegador
(HTML5 + TypeScript + Three.js/WebGL2), com visual realista: planetas esféricos inteiros
com terreno contínuo e escavável, vegetação e fauna 3D procedurais, atmosfera com
dispersão de luz e iluminação HDR.

## Como rodar

```bash
npm install
npm run dev      # servidor de desenvolvimento (http://localhost:5173)
npm run build    # typecheck + build de produção em dist/
npm run preview  # serve o build de produção
```

### Versões para jogar sem servidor

```bash
npm run build:standalone   # dist-standalone/index.html: um único arquivo, abre com duplo clique
npm run desktop:win        # executável Windows em desktop/out/ (Electron)
npm run desktop:linux      # idem para Linux · desktop:mac para macOS (Apple Silicon)
npm run launcher:win       # release/Horizonte.exe: launcher leve (Go) com o jogo embutido
```

Os comandos `desktop:*` exigem antes `npm install --prefix desktop`. O build standalone
embute scripts, estilos, fontes e o worker de geração num só HTML, por isso funciona
também a partir de `file://`. No app desktop: F11 ou Alt+Enter alterna tela cheia.
O launcher (`desktop/launcher`, requer Go) extrai o jogo para `%LOCALAPPDATA%\HorizonteVoxel`
e o abre numa janela de aplicativo do Edge/Chrome, sem barras do navegador.

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
| 1–5 / roda (na nave) | nível de velocidade: Precisão 30 m/s, Manobra 90, Normal 260, Rápido 750, Hiper 2,5 km/s |

## Arquitetura

```
src/
  core/        rng determinístico, ruído simplex/tileável, input, configurações
  universe/    galáxia por setores, gerador de sistemas estelares, tipos planetários,
               órbitas e referenciais (StarSystem)
  planet/      mapeamento cube-sphere, gerador de terreno (campo de densidade), LOD
               quadtree, tiles/bakes, posicionamento determinístico da vegetação
  voxel/       materiais, paleta PBR, malhas (Surface Nets + peças construídas), worker,
               streaming de chunks (VoxelWorld)
  physics/     colisão e raycast contra a superfície suave do campo de densidade
  render/      pipeline HDR, composição atmosfera/oceano/nuvens, pós-processo,
               céu, estrela, corpos distantes, materiais de terreno, texturas procedurais
  player/      astronauta (rig + animação procedural)
  ship/        modelo e física da nave
  game/        Game (orquestração), Universe, Player, Pilot, Effects, Fauna, Flora, Tools
  survival/    sinais vitais; weather/ clima; items/ inventário e receitas
  building/    módulos de base, rede elétrica, pressurização de habitat
  audio/       motor de áudio 100% procedural (Web Audio)
  save/        salvamento versionado em IndexedDB (deltas RLE de chunks)
  campaign/    sequência inicial de objetivos
  ui/          HUD, menus, terminal e mapas
```

### Decisões técnicas principais

- **Planetas esféricos (cube-sphere equiangular) com terreno contínuo.** Cada planeta tem
  6 faces com `N×N` colunas e 512 camadas radiais de células de ~1 m. Cada célula guarda
  um material e uma **densidade** (distância com sinal à superfície, ±2 células). A
  superfície é a isossuperfície 0,5 desse campo, extraída por *Surface Nets* com normais
  pelo gradiente: relevo exato, sem degraus, e ainda editável (escavar abre crateras
  suaves, materiais naturais elevam o terreno). Peças construídas (painéis, vidro,
  concreto) continuam sendo cubos encaixados na mesma grade.
- **Colisão contra o campo.** O jogador segue o relevo amostrando o campo trilinear:
  rampas suaves, pequenos ressaltos transpostos, paredes e tetos bloqueiam o corpo. O
  raycast marcha no campo e refina o cruzamento por bisseção. Por isso não foi usado um
  motor de física genérico: a colisão exata com o campo dispensa reconstruir malhas de
  colisão a cada escavação.
- **Vegetação 3D procedural.** Árvores folhosas, coníferas, palmeiras, árvores secas e
  bioluminescentes, arbustos, samambaias, fungos, cristais, corais e rochas são gerados
  em duas resoluções (perto/longe) e instanciados por coluna de chunk conforme bioma,
  temperatura, umidade e inclinação, com vento, colisão nos troncos e coleta.
- **Determinismo.** Galáxia, sistemas, planetas, minérios, flora, estruturas e espécies
  derivam de sementes (`hash32`). Só as modificações do jogador são salvas.
- **Streaming assíncrono.** Workers geram chunks, extraem as malhas, posicionam a
  vegetação, geram tiles de LOD e texturas. O LOD distante é descartado dentro do raio já
  coberto pelo terreno detalhado.
- **Precisão / floating origin.** Simulação em doubles (JS) em referenciais locais: o
  referencial co-rotativo do corpo onde o jogador está, ou o referencial do sistema.
  A câmera fica sempre na origem do espaço de renderização; tudo é posicionado em
  relação a ela na CPU. Profundidade logarítmica cobre de 5 cm a 200 000 km.
- **Atmosfera e oceano num único passe de composição** (Rayleigh + Mie com sombra
  planetária, oceano analítico com ondas, refração/absorção, espuma, reflexo do céu,
  camada de nuvens com sombras projetadas, neblina subaquática), seguido de
  autoexposição, bloom, tonemapping ACES, color grading e FXAA.

## Estado atual

Vertical slice jogável cobrindo as fases 1–5 do plano, com polimento visual em andamento. O visual
em blocos foi substituído por um estilo realista: terreno contínuo, vegetação 3D, astronauta e
fauna com formas orgânicas.

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

### Modo Explorador (fácil)

Escolha **Explorador** em *Novo Jogo* (ou ligue/desligue a qualquer momento no menu de pausa):
a nave começa intacta e abastecida, nunca gasta combustível nem sofre danos, o salto
interestelar dispensa Núcleo e Células de Dobra, e o traje não consome oxigênio nem energia.

### Testes

Os fluxos principais são verificados com scripts Playwright (Chromium/SwiftShader):
novo jogo, caminhada, mineração, fabricação, reparo, decolagem, órbita, viagem e pouso em
outra lua, pressurização de habitat, salto interestelar, salvar → recarregar → continuar,
todas as abas do terminal, visita a cada tipo de planeta e fauna. Em CPU, um passo de
simulação custa ~1 ms; a cena típica na superfície fica em ~1 M triângulos / ~400 draw calls.

### Próximos passos

- Mais variedade de biomas, estruturas e espécies; árvore tecnológica mais longa.
- Otimizações de GPU para os presets altos (oclusão de chunks, instancing de flora).
- Mais tipos de estação e eventos espaciais; interiores de nave navegáveis a pé.
