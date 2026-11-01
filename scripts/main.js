/**
 * Fog Hex Editor
 *
 * Edits the saved fog of war (FogExploration documents) one grid cell at a time.
 * Each user has their own FogExploration document per scene (and per level on v14);
 * its `explored` field is an image of the scene rectangle where the red channel marks
 * explored pixels. We decode that image, paint the chosen cells black (hide) or white
 * (reveal), and save it back. Foundry reloads the fog on the owning user's client when
 * their document changes.
 *
 * To stop a connected player's client from saving its stale in-memory fog over the fix,
 * the GM first asks every affected client to flush its pending fog and pause fog saves
 * ("hold"), makes the edit, then releases the hold.
 */

const MODULE_ID = "fog-hex-editor";
const LAYER_NAME = "fogHexEditor";
const SOCKET = `module.${MODULE_ID}`;
const HOLD_MS = 10000;          // safety cap on how long a client pauses fog saves
const HOLD_WAIT_MS = 2500;      // how long the GM waits for clients to confirm the flush
const OVERLAY_MAX = 2048;       // max preview texture size (px)

const L = (k) => game.i18n.localize(`FHE.${k}`);
const F = (k, data) => game.i18n.format(`FHE.${k}`, data);
const Graphics = () => PIXI.LegacyGraphics ?? PIXI.Graphics;

/* -------------------------------------------- */
/*  Fog documents                               */
/* -------------------------------------------- */

const fogClass = () => CONFIG.FogExploration.documentClass;

/** The level currently viewed (v14), or null on v13 / single-level setups without levels. */
function currentLevelId() {
  return canvas.scene?._view ?? canvas.fog?.exploration?._source?.level ?? null;
}

const docUserId = (doc) => doc._source?.user ?? doc.user?.id ?? doc.user;
const docSceneId = (doc) => doc._source?.scene ?? doc.scene?.id ?? doc.scene;
const docLevelId = (doc) => doc._source?.level ?? null;

/** Fetch every user's FogExploration for a scene (and current level) fresh from the server. */
async function fetchExplorations(scene) {
  const cls = fogClass();
  let docs = [];
  try {
    docs = await cls.database.get(cls, { query: { scene: scene.id } }) ?? [];
  } catch (err) {
    console.warn(`${MODULE_ID} | scene-wide fog query failed, falling back to per-user loads`, err);
  }
  if (!docs.length) {
    for (const user of game.users) {
      try {
        const d = await cls.load({ scene, user });
        if (d) docs.push(d);
      } catch (err) { /* user has none / no access */ }
    }
  }
  const level = currentLevelId();
  return docs.filter((d) => docSceneId(d) === scene.id
    && (!level || docLevelId(d) == null || docLevelId(d) === level));
}

/**
 * Foundry only updates/deletes documents that sit in the client's FogExploration
 * collection. Other users' fog isn't cached on the GM's client, so put the freshly
 * fetched document there for the duration of the operation, then remove it again
 * (so no stale copy lingers). The GM's own cached document is used as-is.
 */
async function withCachedDoc(doc, fn) {
  const coll = fogClass().collection ?? game.collections.get("FogExploration");
  if (!coll) return fn(doc);
  const existing = coll.get(doc.id);
  if (existing) return fn(existing);
  coll.set(doc.id, doc);
  try { return await fn(doc); }
  finally { if (coll.get(doc.id) === doc) coll.delete(doc.id); }
}

/* -------------------------------------------- */
/*  Targets                                     */
/* -------------------------------------------- */

function targetUsers() {
  const t = game.settings.get(MODULE_ID, "targets") ?? {};
  if (t.mode === "custom") return game.users.filter((u) => (t.ids ?? []).includes(u.id));
  return game.users.filter((u) => !u.isGM);
}

async function chooseTargets() {
  const t = game.settings.get(MODULE_ID, "targets") ?? {};
  const custom = t.mode === "custom";
  const ids = new Set(t.ids ?? []);
  let withFog = new Set();
  if (canvas.scene) {
    try { withFog = new Set((await fetchExplorations(canvas.scene)).filter((d) => d.explored).map(docUserId)); }
    catch (err) { /* ignore */ }
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const rows = game.users.contents
    .sort((a, b) => (a.isGM - b.isGM) || a.name.localeCompare(b.name))
    .map((u) => {
      const tags = [
        u.isGM ? L("Targets.GM") : null,
        u.active ? L("Targets.Online") : null,
        withFog.has(u.id) ? L("Targets.HasFog") : L("Targets.NoFog")
      ].filter(Boolean).join(", ");
      const checked = custom ? ids.has(u.id) : !u.isGM;
      return `<label class="fhe-user"><input type="checkbox" name="user" value="${u.id}" ${checked ? "checked" : ""}>
        <span class="fhe-swatch" style="background:${u.color?.css ?? u.color}"></span>
        <span class="fhe-name">${esc(u.name)}</span><span class="fhe-tags">${tags}</span></label>`;
    }).join("");
  const content = `<div class="fog-hex-editor fhe-targets">
      <p class="fhe-hint">${L("Targets.Hint")}</p>
      <label class="fhe-mode"><input type="radio" name="mode" value="players" ${custom ? "" : "checked"}> ${L("Targets.AllPlayers")}</label>
      <label class="fhe-mode"><input type="radio" name="mode" value="custom" ${custom ? "checked" : ""}> ${L("Targets.Custom")}</label>
      <div class="fhe-users">${rows}</div>
    </div>`;

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: "FHE.Targets.Title", icon: "fa-solid fa-users" },
    content,
    ok: {
      label: "FHE.Targets.Save",
      callback: (_event, button) => {
        const form = button.form;
        let mode = form.querySelector("input[name=mode]:checked")?.value ?? "players";
        const picked = [...form.querySelectorAll("input[name=user]:checked")].map((i) => i.value);
        // If the ticks differ from "every non-GM user", the ticks win.
        const players = game.users.filter((u) => !u.isGM).map((u) => u.id);
        const same = picked.length === players.length && players.every((id) => picked.includes(id));
        if (!same) mode = "custom";
        return { mode, ids: picked };
      }
    },
    render: (_event, dialog) => {
      const root = dialog?.element ?? dialog;
      const form = root?.querySelector?.(".fhe-targets");
      if (!form) return;
      const radio = (v) => form.querySelector(`input[name=mode][value=${v}]`);
      form.querySelectorAll("input[name=user]").forEach((box) => box.addEventListener("change", () => {
        radio("custom").checked = true;
      }));
      radio("players").addEventListener("change", () => {
        form.querySelectorAll("input[name=user]").forEach((box) => {
          box.checked = !game.users.get(box.value)?.isGM;
        });
      });
    },
    rejectClose: false
  });
  if (!result) return;
  await game.settings.set(MODULE_ID, "targets", result);
  announceTargets();
  canvas[LAYER_NAME]?.refreshOverlay();
}

function announceTargets() {
  const users = targetUsers();
  if (!users.length) return ui.notifications.warn(L("Notify.NoTargets"));
  ui.notifications.info(F("Notify.Active", { names: users.map((u) => u.name).join(", ") }));
}

/* -------------------------------------------- */
/*  Hold protocol (pause player fog saves)      */
/* -------------------------------------------- */

let holdUntil = 0;
let heldBy = null;
const holdWaiters = new Map(); // holdId -> {pending:Set, resolve}

function installSaveGuard() {
  const proto = foundry.canvas?.perception?.FogManager?.prototype;
  if (!proto || typeof proto.save !== "function") {
    console.warn(`${MODULE_ID} | FogManager#save not found; live players may need to reload after an edit.`);
    return;
  }
  const original = proto.save;
  proto.save = function fheGuardedSave(...args) {
    if (Date.now() < holdUntil) return Promise.resolve();
    return original.apply(this, args);
  };
  proto.save.fheOriginal = original;
}

async function flushOwnFog() {
  try {
    if (!canvas.ready || !canvas.fog?._updated) return;
    const save = canvas.fog.save.fheOriginal ?? canvas.fog.save;
    await save.call(canvas.fog);
  } catch (err) {
    console.warn(`${MODULE_ID} | fog flush failed`, err);
  }
}

function onSocket(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hold": {
      if (!msg.users?.includes(game.user.id)) return;
      holdUntil = Date.now() + HOLD_MS;
      heldBy = msg.holdId;
      flushOwnFog().finally(() => game.socket.emit(SOCKET, { type: "held", holdId: msg.holdId, userId: game.user.id }));
      return;
    }
    case "release": {
      if (msg.holdId === heldBy) { holdUntil = 0; heldBy = null; }
      return;
    }
    case "held": {
      const w = holdWaiters.get(msg.holdId);
      if (!w) return;
      w.pending.delete(msg.userId);
      if (!w.pending.size) w.resolve();
      return;
    }
  }
}

/** Ask connected target clients to flush and pause fog saves; resolves when all confirm (or timeout). */
async function requestHold(users) {
  const holdId = foundry.utils.randomID();
  const others = users.filter((u) => u.active && !u.isSelf);
  if (users.some((u) => u.isSelf)) await flushOwnFog();
  if (!others.length) return holdId;
  await new Promise((resolve) => {
    const pending = new Set(others.map((u) => u.id));
    const done = () => { holdWaiters.delete(holdId); resolve(); };
    holdWaiters.set(holdId, { pending, resolve: done });
    setTimeout(done, HOLD_WAIT_MS);
    game.socket.emit(SOCKET, { type: "hold", holdId, users: others.map((u) => u.id) });
  });
  return holdId;
}

function releaseHold(holdId) {
  game.socket.emit(SOCKET, { type: "release", holdId });
}

/* -------------------------------------------- */
/*  Image editing                               */
/* -------------------------------------------- */

async function loadImage(src) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  return img;
}

function blankCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  return c;
}

function defaultFogSize() {
  const d = canvas.dimensions;
  const res = Math.min(1, 4096 / Math.max(d.sceneWidth, d.sceneHeight));
  return { w: Math.max(1, Math.round(d.sceneWidth * res)), h: Math.max(1, Math.round(d.sceneHeight * res)) };
}

async function exploredToCanvas(explored, size) {
  if (!explored) return blankCanvas(size.w, size.h);
  const img = await loadImage(explored);
  const c = blankCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  return c;
}

/** Grid cell polygon in world coordinates. */
function cellPolygon(offset) {
  return canvas.grid.getVertices(offset);
}

function cellCenter(offset) {
  return canvas.grid.getCenterPoint(offset);
}

/** Paint cells into a fog image canvas. mode: "hide" | "reveal". */
function paintCells(c, cells, mode) {
  const d = canvas.dimensions;
  const sx = c.width / d.sceneWidth;
  const sy = c.height / d.sceneHeight;
  const padPx = Math.max(0, Number(game.settings.get(MODULE_ID, "edgePadding")) || 0);
  const ctx = c.getContext("2d");
  ctx.fillStyle = mode === "hide" ? "#000000" : "#ffffff";
  for (const cell of cells) {
    const verts = cellPolygon(cell);
    if (!verts?.length) continue;
    const ctr = cellCenter(cell);
    ctx.beginPath();
    verts.forEach((p, idx) => {
      const dx = (p.x - ctr.x) * sx;
      const dy = (p.y - ctr.y) * sy;
      const len = Math.hypot(dx, dy) || 1;
      const k = (len + padPx) / len;
      const x = (ctr.x - d.sceneX) * sx + dx * k;
      const y = (ctr.y - d.sceneY) * sy + dy * k;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }
}

function encodeFog(c) {
  return c.toDataURL("image/webp", 1);
}

/* -------------------------------------------- */
/*  Edits and undo                              */
/* -------------------------------------------- */

let busy = false;
const undoStack = []; // {sceneId, levelId, userIds, entries:[{docId, before, created}]}

function sceneChecks() {
  if (!canvas.ready || !canvas.scene) return false;
  if (canvas.grid.isGridless) { ui.notifications.warn(L("Notify.Gridless")); return false; }
  if (canvas.fog?.fogExploration === false) { ui.notifications.warn(L("Notify.NoExploration")); return false; }
  return true;
}

/**
 * Hide or reveal grid cells in the saved fog of the chosen users.
 * @param {{i:number,j:number}[]} cells  grid offsets
 * @param {"hide"|"reveal"} mode
 * @param {User[]} [users]               defaults to the configured targets
 */
async function editCells(cells, mode, users = targetUsers()) {
  if (!game.user.isGM || !cells.length || !sceneChecks()) return;
  if (!users.length) return ui.notifications.warn(L("Notify.NoTargets"));
  if (busy) return ui.notifications.warn(L("Notify.Busy"));
  busy = true;
  const scene = canvas.scene;
  const levelId = currentLevelId();
  const holdId = await requestHold(users);
  const entries = [];
  let failures = 0;
  try {
    const docs = await fetchExplorations(scene);
    const byUser = new Map(docs.map((d) => [docUserId(d), d]));
    const withImage = docs.find((d) => d.explored);
    let size = defaultFogSize();
    if (withImage) {
      try { const img = await loadImage(withImage.explored); size = { w: img.naturalWidth, h: img.naturalHeight }; }
      catch (err) { /* keep default */ }
    }
    const cls = fogClass();
    for (const user of users) {
      const doc = byUser.get(user.id);
      const before = doc?.explored || null;
      if (!before && mode === "hide") continue;
      try {
        const c = await exploredToCanvas(before, size);
        paintCells(c, cells, mode);
        const after = encodeFog(c);
        if (doc) {
          await withCachedDoc(doc, (d) => d.update({ explored: after }));
          entries.push({ docId: doc.id, userId: user.id, before, created: false });
        } else {
          const data = { scene: scene.id, user: user.id, explored: after };
          if (levelId && cls.schema?.fields?.level) data.level = levelId;
          const created = await cls.create(data);
          if (created) entries.push({ docId: created.id, userId: user.id, before: null, created: true });
        }
      } catch (err) {
        console.error(`${MODULE_ID} | failed to edit fog for ${user.name}`, err);
        failures++;
        ui.notifications.error(F("Notify.Failed", { name: user.name, error: err?.message ?? err }));
      }
    }
  } finally {
    releaseHold(holdId);
    busy = false;
  }
  if (!entries.length) {
    if (!failures) ui.notifications.info(L("Notify.Nothing"));
  } else {
    undoStack.push({ sceneId: scene.id, levelId, userIds: entries.map((e) => e.userId), entries });
    if (undoStack.length > 50) undoStack.shift();
    ui.notifications.info(F("Notify.Done", {
      mode: L(mode === "hide" ? "Notify.Hidden" : "Notify.Revealed"),
      cells: cells.length,
      users: entries.length
    }));
  }
  canvas[LAYER_NAME]?.refreshOverlay();
}

async function undo() {
  if (!game.user.isGM) return;
  const last = undoStack.at(-1);
  if (!last) return ui.notifications.info(L("Notify.NothingToUndo"));
  if (last.sceneId !== canvas.scene?.id || last.levelId !== currentLevelId()) {
    return ui.notifications.warn(L("Notify.UndoOtherScene"));
  }
  if (busy) return ui.notifications.warn(L("Notify.Busy"));
  busy = true;
  undoStack.pop();
  const users = last.userIds.map((id) => game.users.get(id)).filter(Boolean);
  const holdId = await requestHold(users);
  try {
    const docs = await fetchExplorations(canvas.scene);
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const e of last.entries) {
      const doc = byId.get(e.docId);
      if (!doc) continue;
      try {
        if (e.created) await withCachedDoc(doc, (d) => d.delete());
        else await withCachedDoc(doc, (d) => d.update({ explored: e.before }));
      } catch (err) {
        console.error(`${MODULE_ID} | undo failed for ${e.userId}`, err);
      }
    }
  } finally {
    releaseHold(holdId);
    busy = false;
  }
  ui.notifications.info(L("Notify.Undone"));
  canvas[LAYER_NAME]?.refreshOverlay();
}

/* -------------------------------------------- */
/*  Canvas layer                                */
/* -------------------------------------------- */

const cellKey = (o) => `${o.i},${o.j}`;

class FogHexEditorLayer extends foundry.canvas.layers.InteractionLayer {

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: LAYER_NAME, zIndex: 610 });
  }

  static prepareSceneControls() {
    if (!game.user.isGM) return null;
    return {
      name: LAYER_NAME,
      order: 8,
      title: "FHE.Controls.Title",
      layer: LAYER_NAME,
      icon: "fa-solid fa-border-none",
      onChange: (_event, active) => { if (active) canvas[LAYER_NAME]?.activate(); },
      tools: {
        hide:    { name: "hide",    order: 1, title: "FHE.Controls.Hide",    icon: "fa-solid fa-eye-slash" },
        reveal:  { name: "reveal",  order: 2, title: "FHE.Controls.Reveal",  icon: "fa-solid fa-eye" },
        targets: { name: "targets", order: 3, title: "FHE.Controls.Targets", icon: "fa-solid fa-users", button: true, onChange: () => chooseTargets() },
        refresh: { name: "refresh", order: 4, title: "FHE.Controls.Refresh", icon: "fa-solid fa-arrows-rotate", button: true, onChange: () => canvas[LAYER_NAME]?.refreshOverlay() },
        undo:    { name: "undo",    order: 5, title: "FHE.Controls.Undo",    icon: "fa-solid fa-rotate-left", button: true, onChange: () => undo() }
      },
      activeTool: "hide"
    };
  }

  /* ---- lifecycle ---- */

  async _draw(options) {
    await super._draw(options);
    this.overlay = null;
    this.strokeGfx = this.addChild(new (Graphics())());
    this.hoverGfx = this.addChild(new (Graphics())());
    this.stroke = null;
    this._onPointerMove = this._onPointerMove.bind(this);
  }

  async _tearDown(options) {
    canvas.stage?.off?.("pointermove", this._onPointerMove);
    this._destroyOverlay();
    this.stroke = null;
    return super._tearDown(options);
  }

  _activate() {
    if (!game.user.isGM) return;
    canvas.stage.on("pointermove", this._onPointerMove);
    if (canvas.grid.isGridless) ui.notifications.warn(L("Notify.Gridless"));
    else announceTargets();
    this.refreshOverlay();
  }

  _deactivate() {
    canvas.stage?.off?.("pointermove", this._onPointerMove);
    this.hoverGfx?.clear();
    this.strokeGfx?.clear();
    this.stroke = null;
    this._destroyOverlay();
  }

  /* ---- preview of explored fog ---- */

  _destroyOverlay() {
    if (!this.overlay) return;
    this.overlay.destroy({ children: true, texture: true, baseTexture: true, textureSource: true });
    this.overlay = null;
  }

  async refreshOverlay() {
    if (!this.active || !canvas.scene || !game.user.isGM) return;
    const token = (this._overlayToken = foundry.utils.randomID());
    const users = new Set(targetUsers().map((u) => u.id));
    let docs = [];
    try { docs = (await fetchExplorations(canvas.scene)).filter((d) => users.has(docUserId(d)) && d.explored); }
    catch (err) { console.warn(`${MODULE_ID} | preview fetch failed`, err); }

    const d = canvas.dimensions;
    const res = Math.min(1, OVERLAY_MAX / Math.max(d.sceneWidth, d.sceneHeight));
    const w = Math.max(1, Math.round(d.sceneWidth * res));
    const h = Math.max(1, Math.round(d.sceneHeight * res));
    const c = blankCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.globalCompositeOperation = "lighten";
    for (const doc of docs) {
      try { ctx.drawImage(await loadImage(doc.explored), 0, 0, w, h); }
      catch (err) { console.warn(`${MODULE_ID} | could not decode fog of ${docUserId(doc)}`, err); }
    }
    if (token !== this._overlayToken || !this.active) return; // superseded

    ctx.globalCompositeOperation = "source-over";
    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    const ColorCls = foundry.utils.Color ?? globalThis.Color;
    const color = ColorCls.from(game.settings.get(MODULE_ID, "overlayColor") || "#5a0f8c");
    const [r, g, b] = color.rgb.map((v) => Math.round(v * 255));
    const opacity = Math.min(1, Math.max(0, Number(game.settings.get(MODULE_ID, "overlayOpacity")) || 0.6));
    for (let i = 0; i < px.length; i += 4) {
      const unexplored = 255 - px[i];
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
      px[i + 3] = Math.round(unexplored * opacity);
    }
    ctx.putImageData(img, 0, 0);

    this._destroyOverlay();
    const sprite = new PIXI.Sprite(PIXI.Texture.from(c));
    sprite.position.set(d.sceneX, d.sceneY);
    sprite.width = d.sceneWidth;
    sprite.height = d.sceneHeight;
    sprite.eventMode = "none";
    this.overlay = this.addChildAt(sprite, 0);
  }

  /* ---- interaction ---- */

  _mode(event) {
    const base = game.activeTool === "reveal" ? "reveal" : "hide";
    const alt = event?.altKey ?? game.keyboard?.isModifierActive?.("Alt");
    if (!alt) return base;
    return base === "hide" ? "reveal" : "hide";
  }

  _offsetAt(point) {
    if (!point || canvas.grid.isGridless) return null;
    const d = canvas.dimensions;
    if (point.x < d.sceneX || point.y < d.sceneY
      || point.x > d.sceneX + d.sceneWidth || point.y > d.sceneY + d.sceneHeight) return null;
    const o = canvas.grid.getOffset(point);
    return { i: o.i, j: o.j };
  }

  _drawCells(gfx, cells, mode, fillAlpha) {
    const color = mode === "hide" ? 0xd9343f : 0x3fbf5f;
    gfx.lineStyle(2, color, 0.9);
    gfx.beginFill(color, fillAlpha);
    for (const cell of cells) {
      const verts = cellPolygon(cell);
      if (verts?.length) gfx.drawPolygon(verts.flatMap((p) => [p.x, p.y]));
    }
    gfx.endFill();
  }

  _onPointerMove(event) {
    if (!this.active || this.stroke) return;
    const pos = event?.getLocalPosition ? event.getLocalPosition(canvas.stage) : canvas.mousePosition;
    const cell = this._offsetAt(pos);
    const key = cell ? cellKey(cell) : null;
    const mode = this._mode(event);
    if (key === this._hoverKey && mode === this._hoverMode) return;
    this._hoverKey = key;
    this._hoverMode = mode;
    this.hoverGfx.clear();
    if (cell) this._drawCells(this.hoverGfx, [cell], mode, 0.2);
  }

  _canDragLeftStart(user, _event) {
    return user.isGM && !canvas.grid.isGridless;
  }

  _addToStroke(point) {
    const s = this.stroke;
    if (!s) return;
    const from = s.last ?? point;
    const dist = Math.hypot(point.x - from.x, point.y - from.y);
    const step = Math.max(4, canvas.grid.size / 4);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let k = 1; k <= n; k++) {
      const p = { x: from.x + (point.x - from.x) * (k / n), y: from.y + (point.y - from.y) * (k / n) };
      const cell = this._offsetAt(p);
      if (cell) s.cells.set(cellKey(cell), cell);
    }
    s.last = point;
    this.strokeGfx.clear();
    this._drawCells(this.strokeGfx, [...s.cells.values()], s.mode, 0.35);
  }

  _onClickLeft(event) {
    if (!game.user.isGM) return;
    const cell = this._offsetAt(event.interactionData?.origin);
    if (!cell) return;
    editCells([cell], this._mode(event));
  }

  _onDragLeftStart(event) {
    const origin = event.interactionData.origin;
    this.hoverGfx.clear();
    this.stroke = { mode: this._mode(event), cells: new Map(), last: null };
    this._addToStroke(origin);
  }

  _onDragLeftMove(event) {
    if (!this.stroke) return;
    this._addToStroke(event.interactionData.destination);
  }

  _onDragLeftDrop(event) {
    if (!this.stroke) return;
    this._addToStroke(event.interactionData.destination);
    const { cells, mode } = this.stroke;
    this.stroke = null;
    this.strokeGfx.clear();
    this._hoverKey = null;
    editCells([...cells.values()], mode);
  }

  _onDragLeftCancel(_event) {
    this.stroke = null;
    this.strokeGfx?.clear();
  }

  _onUndoKey(_event) {
    undo();
    return true;
  }
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "targets", {
    scope: "client", config: false, type: Object, default: { mode: "players", ids: [] }
  });
  game.settings.register(MODULE_ID, "edgePadding", {
    name: "FHE.Settings.EdgePadding.Name", hint: "FHE.Settings.EdgePadding.Hint",
    scope: "client", config: true, type: Number, default: 1,
    range: { min: 0, max: 4, step: 0.5 }
  });
  game.settings.register(MODULE_ID, "overlayOpacity", {
    name: "FHE.Settings.OverlayOpacity.Name", hint: "FHE.Settings.OverlayOpacity.Hint",
    scope: "client", config: true, type: Number, default: 0.6,
    range: { min: 0.1, max: 1, step: 0.05 },
    onChange: () => canvas[LAYER_NAME]?.refreshOverlay()
  });
  const ColorField = foundry.data?.fields?.ColorField;
  game.settings.register(MODULE_ID, "overlayColor", {
    name: "FHE.Settings.OverlayColor.Name", hint: "FHE.Settings.OverlayColor.Hint",
    scope: "client", config: true,
    type: ColorField ? new ColorField({ nullable: false, initial: "#5a0f8c" }) : String,
    default: "#5a0f8c",
    onChange: () => canvas[LAYER_NAME]?.refreshOverlay()
  });

  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: FogHexEditorLayer, group: "interface" };
  installSaveGuard();

  game.modules.get(MODULE_ID).api = {
    /** editCells([{i,j}], "hide"|"reveal", [users]) */
    editCells,
    hide: (cells, users) => editCells(cells, "hide", users),
    reveal: (cells, users) => editCells(cells, "reveal", users),
    undo,
    chooseTargets,
    targetUsers
  };
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
});
