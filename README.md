# Desert Fireworks VR 🎆

A WebXR fireworks sandbox for **Meta Quest** (built and tuned for Quest 3). You're alone in a
wide-open desert at night — moonlit dunes, a huge starfield, distant mesas — with a supply
crate that never runs out of fireworks, and a burning torch.

Grab a rocket. Push its stick into the sand at whatever angle you like. Touch the torch
flame to the fuse. Step back.

![campsite](docs/campsite.png)
![burst](docs/burst.png)

## What's in the crate

| Item | What it does |
| --- | --- |
| **Bottle Rocket** | small, quick, snappy pop |
| **Sky Rocket** | the classic — peony, dahlia, ring, willow, crossette… |
| **Mammoth Rocket** | huge multi-break shells, palm bursts, serious bass |
| **Grand Shell Rocket** | high, slow-opening display shells that fill much more of the sky |
| **Desert Bloom Fountain** | 10 seconds of color-shifting sparks and hiss |
| **Roman Candle** | 8 comets — you can hold this one while it fires and aim it |
| **Finale Cake** | 16-shot barrage with brocade crowns, serpent stars, and a triple-break finale |
| **Firecracker Belt** | a three-foot braided belt of 96 crackers — ships as a flat scarlet roll, dangles from wherever you grab it, and once the fuse catches it rips end-to-end (RRRAHTAHTAHTAH), jumping and writhing and shredding red paper everywhere. Light it and *throw* it |

Every shell picks a random effect and color palette, so no two are the same. The crate
quietly restocks itself.

## The detonator

Off to the right of camp sits a wooden **TNT plunger box** — hazard chevrons, blinking
armed lamp, red wire snaking away over the dunes. Grab the T-handle and shove it all the
way down (desktop: just click it). A spark races along the wire to a buried mortar
battery and a choreographed **two-minute grand finale** fills the sky: opening gold
brocade, color chases, a hushed willow interlude, **niagara waterfall curtains** — lines
of horsetail shells breaking in unison so their striated silver trails pour down the sky
in sheets, frying-metal sizzle and all — then an escalating barrage and a salute chain
to close. The handle springs back up when the desert goes quiet, ready to go again.

## The drone show

Off to the **left** of camp stands a field console on a steel post — teal-bordered
control head, whip antenna, a little status screen, one big green button. Press it
(touch it with either hand in VR; click it on desktop) and **840 LED drones** wake up
on a staging pad out in the western dunes and climb into the night in a rolling wave.

It's the anti-firework: silent (just a faint motor hum on the wind), slow, deliberate,
nothing explodes. The swarm spends about three and a half minutes morphing through a
program of formations — a glowing amber wall, a rotating **teal-to-violet sphere**, a
turning **DNA helix**, a monumental **saguaro** with blossom crowns, a beating
**heart**, a frozen **starburst** (one firework that never fades, as a courtesy to the
hosts), a **crescent moon and star**, and a closing **GOOD NIGHT** written across the
sky — then settles back onto the pad in columns and goes dark. The morphs are the
point: drones peel off in waves, cruise on slow arcs, and arrive together as the next
shape blooms, while colors ripple and sweep through the formation per-LED.

The console's screen tracks the current formation. Pressing the button mid-show
**skips to the next formation**; it re-arms once the swarm lands. And yes — the
detonator and the drone console can absolutely run at the same time. The drones are
insured. Probably.

## Play it

### On the Quest (the real thing)

The game is a static web page — WebXR needs a **secure (HTTPS) origin**, so either:

1. **GitHub Pages** (easiest): enable Pages for this repo (Settings → Pages → Source:
   GitHub Actions; the included workflow deploys on every push to `main`). Then open the
   Pages URL in the Quest browser and press **Enter VR**.
2. **Local network**: on a computer on the same Wi-Fi, run

   ```sh
   npm run start:https
   ```

   and open the printed `https://<your-lan-ip>:8443` URL in the Quest browser
   (accept the self-signed-certificate warning once).

**Controls (VR)**

- **Grip** (or trigger) — grab a firework / the torch; grab with the other hand to pass
- **Release near the sand** — plants it at exactly the angle you're holding it (a green ring shows when planting is possible)
- **Torch flame → fuse** — lights it; the fuse sputters for a couple of seconds, so *step back*
- **Left stick** — walk · **Right stick** — snap turn
- Booms thump both controllers, scaled by how close you (unwisely) stood

### On a desktop browser

Run `npm start` and open <http://localhost:8080> (no HTTPS needed without a headset), or use the Pages URL.
**WASD + mouse** to move, **E** to grab/drop, **scroll** to tilt a held firework, **click** to
plant it / to light a fuse while holding the torch, **F** to cheat a lit rocket into existence.

There's also a self-running fireworks show at `?demo=1` if you just want to watch.

## The sound

Almost every sound — the fuse sputter, the launch *thoomp*, the swoosh, and above all
the booms — is **synthesized from first principles** at load time (see
[`src/synth.js`](src/synth.js)). The one exception: two tiny CC0 explosion recordings
(`assets/sounds/`) supply the dense chaotic texture that synthesis can't fake — the
booms use them as their body, and the launch swoosh **granulates them** (short
Hann-windowed grains, pitched up, overlap-added) into its turbulence bed.

- a boom is a Friedlander blast pulse + its ground bounce, the recorded body tilted
  dark by air absorption, an LF chest-thump pulse, and a long rolling brown-noise rumble;
- the launch swoosh peaks in ~15 ms (a real motor comes up to pressure instantly),
  then amplitude and brightness recede together as the rocket leaves — ignition spit,
  granulated turbulence, collapsing-lowpass hiss, pad rumble and propellant sizzle;
- crackle tails are a decaying Poisson rain of tiny shaped-noise snaps;
- the firecracker belt is a modulated Poisson storm tuned against measured
  firecracker-roll acoustics (~18-25 pops/s with near-simultaneous "brrr" clusters and
  momentary lulls, every cracker a different loudness): each pop is a tiny Friedlander
  N-wave + bright noise crack + LF thump + inverted ground bounce, over a rolling roar
  gated by pop density — with lone accent crackers played live at the moving burn front
  so the rattle travels in 3D;
- the waterfall curtains hang on a molten-sizzle loop: frying-hiss, dense micro-crackle
  and a soft mid roar, darkened by distance;
- everything plays through HRTF panners with **true speed-of-sound delay**
  (a shell bursting 150 m up arrives ~0.4 s after the flash) plus a synthesized
  "open desert with distant rock faces" impulse response in a shared convolver.

Several seeded variants of each sample plus randomized playback rate mean no two shots
sound identical. Headphones (or the Quest's speakers, up loud) strongly recommended.
To audition any recipe without a headset: `node tools/render-sounds.mjs out whoosh`.

## Tech notes

- Plain ES modules + [three.js](https://threejs.org) (vendored in `lib/`, pinned via npm) — no build step; the repo *is* the site.
- Explosions run on a stateless GPU particle pool (~36k particles): the CPU writes spawn
  data once and the vertex shader integrates drag + gravity ballistics analytically every
  frame (`src/particles.js`) — Quest-friendly.
- Terrain is an analytic dune heightfield (`src/terrain.js`), so planting, walking, item
  drops and rocket ground-hits all sample the exact same function.
- Lighting is full PBR: a tiny procedural equirect night sky on `scene.environment`
  gives every surface a moonlit sheen (glossy wrappers, metallic nose cones, brass
  lantern), the moon throws real PCF shadows from a tight ortho box over the campsite
  (`?shadows=0` to opt out), and the sand carries a tiling ripple normal map plus a
  view-dependent glitter term injected into the standard shader — head sway makes the
  dunes sparkle, and burst light makes them shimmer.
- Burst flash lights are pooled `PointLight`s that paint the dunes with the shell's
  color (fountain lights are pooled too — changing the scene's light count mid-show
  forces a shader recompile hitch on Quest, so the light count never changes).
- The drone show (`src/drones.js`) renders all 840 LEDs as **one additive `Points`
  draw call**; the CPU flies the swarm with a per-drone spring-damper autopilot
  (retargeting matches drones to formation slots by height-band rank, then staggers
  departures so morphs flow instead of snapping). Formations are procedural point
  clouds — parametric solids, capsule strokes, and canvas-sampled text — in a frame
  that faces the campsite. The distant swarm hum is synthesized like everything else:
  a beating cluster of detuned motor tones over prop-wash noise.
- `tools/screenshot.mjs` is a headless QA harness (Playwright + SwiftShader) that loads
  the demo, verifies zero console errors, and captures screenshots.

## Development

```sh
npm install        # dev deps only (three for vendoring, playwright-core for QA)
npm start          # http://localhost:8080
node tools/screenshot.mjs shots   # headless smoke test + screenshots
```

MIT licensed. All art and audio are procedural — nothing to attribute, everything to remix.
