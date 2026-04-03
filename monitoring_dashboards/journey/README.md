# Journey Dashboard

3D visualization of agent activity across the platform's 110 API routes, grouped into 10 phases. Agents appear as wireframe cubes that fly between routes on bezier arcs.

Served at `/journey/three` by the monitoring proxy.

## File map

```
journey/
├── three.html              # HTML shell — CSS, DOM, importmap, animation loop (~130 lines)
├── js/
│   ├── constants.js        # Colors, sizing, bloom, style state, math helpers
│   ├── manifest.js         # 110 route definitions across 10 phases
│   ├── scene.js            # Three.js renderer, camera, controls, bloom, grid, resize
│   ├── layout.js           # computeLayout() — positions phases/subgroups/routes in 3D
│   ├── builder.js          # buildScene() — creates meshes, sprites, labels, hit volumes
│   ├── agents.js           # AgentMgr (instanced cubes) + FlightMgr (arc animations)
│   ├── events.js           # SSE client — snapshot/event handling, route stats
│   ├── interaction.js      # Raycasting, tooltips, drag-and-drop, keyboard shortcuts
│   ├── hud.js              # Top bar stats, simulate button, phase badge updates
│   └── style-panel.js      # Right-side panel — 30+ knobs, 5 label presets
├── index.html              # Alternate flat dashboard
└── flex.html               # Alternate flex dashboard
```

## What to edit

| Task | File |
|------|------|
| Add/remove/rename a route | `manifest.js` |
| Change 3D layout spacing or grid | `constants.js` + `layout.js` |
| Change how route boxes / labels look | `builder.js` |
| Change agent cube behavior or flight arcs | `agents.js` |
| Change how SSE events are processed | `events.js` |
| Change tooltips, drag, or keyboard shortcuts | `interaction.js` |
| Change HUD stats or simulate button | `hud.js` |
| Change style panel knobs or presets | `style-panel.js` |
| Change camera position, bloom, or scene setup | `scene.js` |

## Keyboard shortcuts

- **D** — copy layout JSON to clipboard
- **S** — copy style JSON to clipboard
- **C** — copy camera position JSON to clipboard
- **Shift+click** — drag route / subgroup / phase
- **Cmd+Z** — undo last drag
