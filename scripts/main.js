const MODULE_ID = 'dc20_stats';

// ── State ─────────────────────────────────────────────────────────────────────

let stats = null;
const pendingAttacks = new Map();
let selectedCombatListIdx = 0;

// ── History persistence ───────────────────────────────────────────────────────

function loadHistory() {
  try {
    const data = game.settings.get(MODULE_ID, 'combatHistory');
    return Array.isArray(data?.combats) ? data.combats : [];
  } catch { return []; }
}

function saveHistory(combats) {
  game.settings.set(MODULE_ID, 'combatHistory', { combats });
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function resetStats(combat) {
  stats = {
    combatId: combat.id,
    name: combat.name || 'Combat',
    rounds: combat.round ?? 0,
    actors: {},
    messageMap: {},
  };
  pendingAttacks.clear();
}

function getOrCreateActor(actorId, fallbackName, fallbackType) {
  if (!stats.actors[actorId]) {
    const actor = game.actors.get(actorId);
    stats.actors[actorId] = {
      id: actorId,
      name: actor?.name ?? fallbackName ?? 'Unknown',
      type: actor?.type ?? fallbackType ?? 'unknown',
      attacksMade: 0,
      hitsLanded: 0,
      timesHit: 0,
      damageDealt: 0,
      maxSingleHit: 0,
      damageTaken: 0,
      healingDone: 0,
      healingReceived: 0,
    };
  }
  return stats.actors[actorId];
}

// ── Message parsing ───────────────────────────────────────────────────────────

function isAttackCard(msg)          { return !!msg.flags?.dc20rpg?.itemId; }
function isConfirmationMessage(c)   { return c.includes('revert-name'); }

function parseConfirmation(content) {
  const dmg = content.match(/Took\s+(\d+)\s+damage/i);
  if (dmg) return { type: 'damage',  amount: parseInt(dmg[1]) };
  const heal = content.match(/Received\s+(\d+)\s+health/i);
  if (heal) return { type: 'healing', amount: parseInt(heal[1]) };
  return null;
}

function extractTargetTokenIds(content) {
  const matches = [...content.matchAll(/data-target="([^"#]+)"/g)];
  return [...new Set(matches.map(m => m[1]))];
}

// ── Hook handlers ─────────────────────────────────────────────────────────────

function onCreateChatMessage(msg) {
  console.log(`${MODULE_ID} | createChatMessage fired, stats=${!!stats}, flags=`, msg.flags);
  if (!stats) return;
  const content = msg.content ?? '';

  if (isAttackCard(msg)) {
    const targets       = extractTargetTokenIds(content);
    const sourceActorId = msg.speaker.actor;
    const source        = { sourceActorId, sourceName: msg.speaker.alias };
    targets.forEach(tid => pendingAttacks.set(tid, source));
    if (sourceActorId) {
      const sourceActor = game.actors.get(sourceActorId);
      if (sourceActor && sourceActor.type !== 'storage') {
        const entry = getOrCreateActor(sourceActorId, msg.speaker.alias, sourceActor.type);
        entry.attacksMade++;
        stats.messageMap[msg.id] = { eventType: 'attack', sourceActorId };
      }
    }
    console.log(`${MODULE_ID} | Card1: attacker=${source.sourceName}, targets=[${targets.join(',')}]`);
    return;
  }

  const isConfirm = isConfirmationMessage(content);
  console.log(`${MODULE_ID} | msg ${msg.id}: isConfirm=${isConfirm}`);
  if (isConfirm) processConfirmationContent(msg, content);
}

function onDeleteChatMessage(msg) {
  if (!stats) return;
  const record = stats.messageMap[msg.id];
  if (!record) return;

  if (record.eventType === 'attack') {
    const source = stats.actors[record.sourceActorId];
    if (source) source.attacksMade = Math.max(0, source.attacksMade - 1);
  } else {
    const { type, amount, targetActorId, sourceActorId } = record;
    const target = stats.actors[targetActorId];
    if (target) {
      if (type === 'damage') { target.damageTaken = Math.max(0, target.damageTaken - amount); target.timesHit = Math.max(0, target.timesHit - 1); }
      else target.healingReceived = Math.max(0, target.healingReceived - amount);
    }
    if (sourceActorId) {
      const source = stats.actors[sourceActorId];
      if (source) {
        if (type === 'damage') { source.damageDealt = Math.max(0, source.damageDealt - amount); source.hitsLanded = Math.max(0, source.hitsLanded - 1); }
        else source.healingDone = Math.max(0, source.healingDone - amount);
      }
    }
  }

  delete stats.messageMap[msg.id];
  statsDialog?.rendered && statsDialog.render({});
}

function onUpdateCombat(combat, changed) {
  if (!stats || combat.id !== stats.combatId) return;
  if (changed.round !== undefined) stats.rounds = changed.round;
}

function onUpdateChatMessage(msg, changes) {
  console.log(`${MODULE_ID} | updateChatMessage ${msg.id}, changeKeys=${Object.keys(changes).join(',')}`);
  if (!stats) return;
  if (stats.messageMap[msg.id]) return;
  const content = changes.content ?? msg.content ?? '';
  if (!isConfirmationMessage(content)) return;
  processConfirmationContent(msg, content);
}

function onRenderChatMessage(msg) {
  if (!stats) return;
  if (stats.messageMap[msg.id]) return;
  const content = msg.content ?? '';
  console.log(`${MODULE_ID} | renderChatMessage ${msg.id}: hasRevert=${content.includes('revert-name')}`);
  if (!isConfirmationMessage(content)) return;
  processConfirmationContent(msg, content);
}

function processConfirmationContent(msg, content) {
  const parsed = parseConfirmation(content);
  console.log(`${MODULE_ID} | processConfirmation parsed:`, parsed, '| speaker:', msg.speaker.alias);
  if (!parsed) return;

  const targetActorId = msg.speaker.actor;
  const targetActor   = game.actors.get(targetActorId);
  if (!targetActor || targetActor.type === 'storage') return;

  const pending       = pendingAttacks.get(msg.speaker.token);
  const sourceActorId = pending?.sourceActorId ?? game.combat?.combatant?.actorId;
  const sourceName    = pending?.sourceName    ?? game.combat?.combatant?.name;

  console.log(`${MODULE_ID} | processConfirmation: target=${targetActor.name}(${targetActor.type}), source=${sourceName}`);

  const targetEntry = getOrCreateActor(targetActorId, msg.speaker.alias, targetActor.type);
  if (parsed.type === 'damage') { targetEntry.damageTaken += parsed.amount; targetEntry.timesHit++; }
  else targetEntry.healingReceived += parsed.amount;

  if (sourceActorId) {
    const sourceActor = game.actors.get(sourceActorId);
    if (sourceActor && sourceActor.type !== 'storage') {
      const src = getOrCreateActor(sourceActorId, sourceName, sourceActor.type);
      if (parsed.type === 'damage') {
        src.damageDealt += parsed.amount;
        src.hitsLanded++;
        if (parsed.amount > src.maxSingleHit) src.maxSingleHit = parsed.amount;
      } else {
        src.healingDone += parsed.amount;
      }
    }
  }

  stats.messageMap[msg.id] = { eventType: 'confirm', ...parsed, targetActorId, sourceActorId };
  statsDialog?.rendered && statsDialog.render({});
}

// ── Awards ────────────────────────────────────────────────────────────────────

function computeAwards(all) {
  const party   = all.filter(a => a.type === 'character' || a.type === 'companion');
  const withPos = (actors, key) => actors.filter(a => (a[key] ?? 0) > 0);
  const topBy   = (list, key)   => list.length ? list.reduce((b, a) => a[key] > b[key] ? a : b) : null;
  const awards  = [];

  const dps    = topBy(withPos(party, 'damageDealt'),   'damageDealt');
  if (dps)    awards.push({ icon: 'fa-fire',           label: 'Top DPS',          name: dps.name,    value: dps.damageDealt });

  const bigHit = topBy(withPos(party, 'maxSingleHit'),  'maxSingleHit');
  if (bigHit) awards.push({ icon: 'fa-bolt',           label: 'Hardest Hit',      name: bigHit.name, value: bigHit.maxSingleHit });

  const healer = topBy(withPos(party, 'healingDone'),   'healingDone');
  if (healer) awards.push({ icon: 'fa-heart',          label: 'Best Healer',      name: healer.name, value: healer.healingDone });

  const hitter = topBy(withPos(party, 'hitsLanded'),    'hitsLanded');
  if (hitter) awards.push({ icon: 'fa-bullseye',       label: 'Most Hits',        name: hitter.name, value: hitter.hitsLanded });

  const missMap = party.map(a => ({ name: a.name, misses: Math.max(0, a.attacksMade - a.hitsLanded) }));
  const misser  = topBy(missMap.filter(a => a.misses > 0), 'misses');
  if (misser) awards.push({ icon: 'fa-ban',            label: 'Most Misses',      name: misser.name, value: misser.misses });

  const tanker = topBy(withPos(party, 'damageTaken'),   'damageTaken');
  if (tanker) awards.push({ icon: 'fa-shield-halved',  label: 'Most Dmg Taken',   name: tanker.name, value: tanker.damageTaken });

  return awards;
}

function computeCrossCombatAwards(history) {
  const merged = {};
  history.forEach(combat => {
    Object.values(combat.actors).forEach(actor => {
      if (actor.type !== 'character' && actor.type !== 'companion') return;
      if (!merged[actor.id]) {
        merged[actor.id] = { ...actor };
      } else {
        const m = merged[actor.id];
        m.attacksMade     += actor.attacksMade     ?? 0;
        m.hitsLanded      += actor.hitsLanded      ?? 0;
        m.timesHit        += actor.timesHit        ?? 0;
        m.damageDealt     += actor.damageDealt     ?? 0;
        m.damageTaken     += actor.damageTaken     ?? 0;
        m.healingDone     += actor.healingDone     ?? 0;
        m.healingReceived += actor.healingReceived ?? 0;
        if ((actor.maxSingleHit ?? 0) > (m.maxSingleHit ?? 0)) m.maxSingleHit = actor.maxSingleHit;
      }
    });
  });
  return computeAwards(Object.values(merged));
}

// ── Dialog ────────────────────────────────────────────────────────────────────

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class CombatStatsDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'dc20-combat-stats-dialog',
    window: { title: 'DC20 — Combat Statistics', resizable: true },
    position: { width: 860 },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/stats-dialog.hbs` },
  };

  async _prepareContext(_options) {
    const history = loadHistory();

    // Build display list: active combat first (if any), then history newest-first.
    const listItems = [];
    if (stats) listItems.push({ data: stats, isCurrent: true, canDelete: false, historyIdx: null });
    history.forEach((c, i) => listItems.push({ data: c, isCurrent: false, canDelete: true, historyIdx: i }));

    if (listItems.length === 0) return { hasData: false };

    const idx      = Math.min(selectedCombatListIdx, listItems.length - 1);
    const selected = listItems[idx];
    const c        = selected.data;

    const all     = Object.values(c.actors);
    const party   = all.filter(a => a.type === 'character' || a.type === 'companion');
    const enemies = all.filter(a => a.type === 'npc');
    const rounds  = Math.max(1, c.rounds);

    const totalDealt   = party.reduce((s, a) => s + a.damageDealt,   0);
    const totalTaken   = party.reduce((s, a) => s + a.damageTaken,   0);
    const totalHealing = party.reduce((s, a) => s + a.healingDone,   0);

    const perCombatAwards = computeAwards(all);
    const crossAwards     = history.length >= 2 ? computeCrossCombatAwards(history) : [];

    return {
      hasData: true,
      combatList: listItems.map((item, i) => ({
        name:       (item.isCurrent ? '★ ' : '') + (item.data.name || 'Combat'),
        date:       item.data.date ? new Date(item.data.date).toLocaleDateString() : '',
        isCurrent:  item.isCurrent,
        canDelete:  item.canDelete,
        historyIdx: item.historyIdx,
        isSelected: i === idx,
        listIdx:    i,
      })),
      combat: {
        name:   c.name,
        rounds: c.rounds,
        date:   c.date ? new Date(c.date).toLocaleString() : '',
      },
      party: party.map(a => ({
        ...a,
        misses:         Math.max(0, a.attacksMade - a.hitsLanded),
        avgDmgPerRound: (a.damageDealt / rounds).toFixed(1),
      })),
      enemies,
      summary: {
        enemyCount:     enemies.length,
        totalDealt,
        totalTaken,
        totalHealing,
        avgDmgPerEnemy: enemies.length ? (totalDealt / enemies.length).toFixed(1) : '—',
      },
      awards:         perCombatAwards,
      hasAwards:      perCombatAwards.length > 0,
      crossAwards,
      hasCrossAwards: crossAwards.length > 0,
    };
  }

  _onRender(_context, _options) {
    // Select a combat from the sidebar list.
    this.element.querySelectorAll('[data-list-idx]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('[data-delete-history-idx]')) return;
        selectedCombatListIdx = parseInt(el.dataset.listIdx);
        this.render({});
      });
    });

    // Delete a combat from history.
    this.element.querySelectorAll('[data-delete-history-idx]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const hIdx   = parseInt(btn.dataset.deleteHistoryIdx);
        const history = loadHistory();
        history.splice(hIdx, 1);
        saveHistory(history);
        const newLen = (stats ? 1 : 0) + history.length;
        if (selectedCombatListIdx >= newLen) selectedCombatListIdx = Math.max(0, newLen - 1);
        this.render({});
      });
    });
  }
}

// ── Module bootstrap ──────────────────────────────────────────────────────────

let statsDialog = null;

function openStatsDialog() {
  if (!statsDialog) statsDialog = new CombatStatsDialog();
  statsDialog.render({ force: true });
}

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | ready`);

  game.settings.register(MODULE_ID, 'combatHistory', {
    name: 'Combat History',
    scope: 'world',
    config: false,
    type: Object,
    default: { combats: [] },
  });

  Hooks.on('combatStart', combat => {
    resetStats(combat);
    ui.notifications.info('DC20 Stats: tracking started.');
  });

  Hooks.on('deleteCombat', combat => {
    if (!stats || stats.combatId !== combat.id) return;
    const record = { ...stats, date: new Date().toISOString() };
    delete record.messageMap;
    const history = [record, ...loadHistory()].slice(0, 30);
    saveHistory(history);
    stats = null;
    selectedCombatListIdx = 0;
    openStatsDialog();
  });

  Hooks.on('updateCombat',      onUpdateCombat);
  Hooks.on('createChatMessage', onCreateChatMessage);
  Hooks.on('updateChatMessage', onUpdateChatMessage);
  Hooks.on('renderChatMessage', onRenderChatMessage);
  Hooks.on('deleteChatMessage', onDeleteChatMessage);

  Hooks.on('renderCombatTracker', (_app, html) => {
    if (!game.combat) return;
    const root     = html instanceof HTMLElement ? html : html[0];
    const controls = root?.querySelector('.combat-controls');
    if (!controls) return;
    const btn = document.createElement('a');
    btn.className  = 'combat-control';
    btn.title      = 'Combat Statistics';
    btn.style.fontSize = '1rem';
    btn.innerHTML  = '<i class="fa-solid fa-chart-bar"></i>';
    btn.addEventListener('click', openStatsDialog);
    controls.prepend(btn);
  });

  game.dc20CombatStats = {
    open:        openStatsDialog,
    getStats:    () => stats,
    getHistory:  () => loadHistory(),
    clearHistory: () => { saveHistory([]); ui.notifications.info('DC20 Stats: history cleared.'); },
    diagnose: () => {
      const s = stats;
      const history = loadHistory();
      const lastMsgs = game.messages.contents.slice(-5).map(m => ({
        id:          m.id,
        speaker:     m.speaker?.alias,
        hasItemFlag: !!m.flags?.dc20rpg?.itemId,
        hasRevert:   m.content?.includes('revert-name'),
        matchDmg:    m.content?.match(/Took\s+(\d+)\s+damage/i)?.[0] ?? null,
        matchHeal:   m.content?.match(/Received\s+(\d+)\s+health/i)?.[0] ?? null,
      }));
      const report = {
        statsActive:  !!s,
        combatMatch:  game.combat?.id === s?.combatId,
        rounds:       s?.rounds,
        actorCount:   Object.keys(s?.actors ?? {}).length,
        actors:       s ? Object.values(s.actors).map(a => ({
          name: a.name, type: a.type,
          atk: a.attacksMade, hits: a.hitsLanded, miss: Math.max(0, a.attacksMade - a.hitsLanded),
          dmgDealt: a.damageDealt, dmgTaken: a.damageTaken,
        })) : [],
        pendingCount: pendingAttacks.size,
        historyCombats: history.length,
        lastMessages: lastMsgs,
      };
      console.log('=== dc20_stats diagnose ===\n' + JSON.stringify(report, null, 2));
      return report;
    },
  };
});
