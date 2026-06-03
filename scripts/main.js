const MODULE_ID = 'dc20_stats';

// ── State ─────────────────────────────────────────────────────────────────────

let stats = null;

// targetTokenId → { sourceActorId, sourceName }
const pendingAttacks = new Map();

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

function isAttackCard(msg) {
  return !!msg.flags?.dc20rpg?.itemId;
}

function isConfirmationMessage(content) {
  return content.includes('revert-name');
}

function parseConfirmation(content) {
  const dmg = content.match(/Took\s+(\d+)\s+damage/i);
  if (dmg) return { type: 'damage', amount: parseInt(dmg[1]) };

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
    const targets      = extractTargetTokenIds(content);
    const sourceActorId = msg.speaker.actor;
    const source        = { sourceActorId, sourceName: msg.speaker.alias };
    targets.forEach(tid => pendingAttacks.set(tid, source));

    // Track attack roll for the attacker.
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
  console.log(`${MODULE_ID} | msg ${msg.id}: isConfirm=${isConfirm}, hasRevertName=${content.includes('revert-name')}`);
  if (!isConfirm) return;

  processConfirmationContent(msg, content);
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
      if (type === 'damage') {
        target.damageTaken = Math.max(0, target.damageTaken - amount);
        target.timesHit    = Math.max(0, target.timesHit - 1);
      } else {
        target.healingReceived = Math.max(0, target.healingReceived - amount);
      }
    }

    if (sourceActorId) {
      const source = stats.actors[sourceActorId];
      if (source) {
        if (type === 'damage') {
          source.damageDealt = Math.max(0, source.damageDealt - amount);
          source.hitsLanded  = Math.max(0, source.hitsLanded - 1);
        } else {
          source.healingDone = Math.max(0, source.healingDone - amount);
        }
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

// renderChatMessage fires after every render, including after DC20 updates message content.
// msg.content holds the final HTML at this point.
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
  if (parsed.type === 'damage') {
    targetEntry.damageTaken += parsed.amount;
    targetEntry.timesHit++;
  } else {
    targetEntry.healingReceived += parsed.amount;
  }

  let sourceActorEntry = null;
  if (sourceActorId) {
    const sourceActor = game.actors.get(sourceActorId);
    if (sourceActor && sourceActor.type !== 'storage') {
      sourceActorEntry = getOrCreateActor(sourceActorId, sourceName, sourceActor.type);
      if (parsed.type === 'damage') {
        sourceActorEntry.damageDealt += parsed.amount;
        sourceActorEntry.hitsLanded++;
        if (parsed.amount > sourceActorEntry.maxSingleHit) sourceActorEntry.maxSingleHit = parsed.amount;
      } else {
        sourceActorEntry.healingDone += parsed.amount;
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

  const awards = [];

  const dps = topBy(withPos(party, 'damageDealt'), 'damageDealt');
  if (dps) awards.push({ icon: 'fa-fire',           label: 'Top DPS',          name: dps.name,    value: dps.damageDealt });

  const bigHit = topBy(withPos(party, 'maxSingleHit'), 'maxSingleHit');
  if (bigHit) awards.push({ icon: 'fa-bolt',        label: 'Hardest Hit',      name: bigHit.name, value: bigHit.maxSingleHit });

  const healer = topBy(withPos(party, 'healingDone'), 'healingDone');
  if (healer) awards.push({ icon: 'fa-heart',       label: 'Best Healer',      name: healer.name, value: healer.healingDone });

  const hitter = topBy(withPos(party, 'hitsLanded'), 'hitsLanded');
  if (hitter) awards.push({ icon: 'fa-bullseye',    label: 'Most Hits',        name: hitter.name, value: hitter.hitsLanded });

  const missMap = party.map(a => ({ name: a.name, misses: Math.max(0, a.attacksMade - a.hitsLanded) }));
  const misser  = topBy(missMap.filter(a => a.misses > 0), 'misses');
  if (misser) awards.push({ icon: 'fa-ban',         label: 'Most Misses',      name: misser.name, value: misser.misses });

  const tanker = topBy(withPos(party, 'damageTaken'), 'damageTaken');
  if (tanker) awards.push({ icon: 'fa-shield-halved', label: 'Most Dmg Taken', name: tanker.name, value: tanker.damageTaken });

  return awards;
}

// ── Dialog ────────────────────────────────────────────────────────────────────

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class CombatStatsDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'dc20-combat-stats-dialog',
    window: { title: 'DC20 — Combat Statistics', resizable: true },
    position: { width: 740 },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/stats-dialog.hbs` },
  };

  async _prepareContext(_options) {
    if (!stats) return { hasStats: false };

    const all     = Object.values(stats.actors);
    const party   = all.filter(a => a.type === 'character' || a.type === 'companion');
    const enemies = all.filter(a => a.type === 'npc');
    const rounds  = Math.max(1, stats.rounds);

    const totalDealt   = party.reduce((s, a) => s + a.damageDealt,   0);
    const totalTaken   = party.reduce((s, a) => s + a.damageTaken,   0);
    const totalHealing = party.reduce((s, a) => s + a.healingDone,   0);

    const awards = computeAwards(all);

    return {
      hasStats: true,
      name:     stats.name,
      rounds:   stats.rounds,
      party: party.map(a => ({
        ...a,
        misses:        Math.max(0, a.attacksMade - a.hitsLanded),
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
      awards,
      hasAwards: awards.length > 0,
    };
  }

  _onRender(_context, _options) {
    this.element.querySelector('[data-action="export"]')
      ?.addEventListener('click', () => exportToTxt());
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportToTxt() {
  if (!stats) { ui.notifications.warn('No combat data to export.'); return; }

  const all     = Object.values(stats.actors);
  const party   = all.filter(a => a.type === 'character' || a.type === 'companion');
  const enemies = all.filter(a => a.type === 'npc');
  const rounds  = Math.max(1, stats.rounds);

  const totalDealt   = party.reduce((s, a) => s + a.damageDealt,   0);
  const totalTaken   = party.reduce((s, a) => s + a.damageTaken,   0);
  const totalHealing = party.reduce((s, a) => s + a.healingDone,   0);

  const col = (s, w) => String(s).padEnd(w);
  const lines = [];

  lines.push(`=== ${stats.name} ===`);
  lines.push(`Date:    ${new Date().toLocaleString()}`);
  lines.push(`Rounds:  ${stats.rounds}`);
  lines.push(`Enemies: ${enemies.length}`);
  lines.push('');

  lines.push('--- PARTY -------------------------------------------------------');
  lines.push(
    col('Name', 22) + col('Atk', 6) + col('Hits', 6) + col('Miss', 6) +
    col('Dmg Dealt', 11) + col('Avg/Rnd', 9) + col('Dmg Taken', 11) +
    col('Healed', 9) + 'Recv.Heal'
  );
  lines.push('-'.repeat(106));
  party.forEach(a => {
    lines.push(
      col(a.name, 22) +
      col(a.attacksMade, 6) +
      col(a.hitsLanded, 6) +
      col(Math.max(0, a.attacksMade - a.hitsLanded), 6) +
      col(a.damageDealt, 11) +
      col((a.damageDealt / rounds).toFixed(1), 9) +
      col(a.damageTaken, 11) +
      col(a.healingDone, 9) +
      a.healingReceived
    );
  });

  if (enemies.length) {
    lines.push('');
    lines.push('--- ENEMIES -----------------------------------------------------');
    lines.push(col('Name', 30) + col('Times Hit', 11) + col('Dmg Taken', 11) + 'Recv.Heal');
    lines.push('-'.repeat(63));
    enemies.forEach(a => {
      lines.push(col(a.name, 30) + col(a.timesHit, 11) + col(a.damageTaken, 11) + a.healingReceived);
    });
  }

  lines.push('');
  lines.push('--- SUMMARY -----------------------------------------------------');
  lines.push(`Total damage dealt by party : ${totalDealt}`);
  lines.push(`Total damage taken by party : ${totalTaken}`);
  lines.push(`Total healing done by party : ${totalHealing}`);
  lines.push(`Avg damage per enemy        : ${enemies.length ? (totalDealt / enemies.length).toFixed(1) : '—'}`);

  const awards = computeAwards(all);
  if (awards.length) {
    lines.push('');
    lines.push('--- AWARDS ------------------------------------------------------');
    awards.forEach(a => lines.push(`${col(a.label, 22)}: ${a.name} (${a.value})`));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `combat-${stats.name.replace(/\s+/g, '_')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Module bootstrap ──────────────────────────────────────────────────────────

let statsDialog = null;

function openStatsDialog() {
  if (!statsDialog) statsDialog = new CombatStatsDialog();
  statsDialog.render({ force: true });
}

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | ready`);

  Hooks.on('combatStart',       combat => { resetStats(combat); ui.notifications.info('DC20 Stats: tracking started.'); });
  Hooks.on('deleteCombat',      combat => { if (stats?.combatId === combat.id) openStatsDialog(); });
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
    btn.className = 'combat-control';
    btn.title     = 'Combat Statistics';
    btn.style.fontSize = '1rem';
    btn.innerHTML = '<i class="fa-solid fa-chart-bar"></i>';
    btn.addEventListener('click', openStatsDialog);
    controls.prepend(btn);
  });

  game.dc20CombatStats = {
    open:     openStatsDialog,
    export:   exportToTxt,
    getStats: () => stats,
    diagnose: () => {
      const s = stats;
      const lastMsgs = game.messages.contents.slice(-5).map(m => ({
        id:          m.id,
        speaker:     m.speaker?.alias,
        hasItemFlag: !!m.flags?.dc20rpg?.itemId,
        hasRevert:   m.content?.includes('revert-name'),
        matchDmg:    m.content?.match(/Took\s+(\d+)\s+damage/i)?.[0] ?? null,
        matchHeal:   m.content?.match(/Received\s+(\d+)\s+health/i)?.[0] ?? null,
      }));
      const report = {
        statsActive:   !!s,
        combatId:      s?.combatId,
        combatActive:  !!game.combat,
        combatMatch:   game.combat?.id === s?.combatId,
        rounds:        s?.rounds,
        actorCount:    Object.keys(s?.actors ?? {}).length,
        actors:        s ? Object.values(s.actors).map(a => ({
          name: a.name, type: a.type,
          atk: a.attacksMade, hits: a.hitsLanded, miss: Math.max(0, a.attacksMade - a.hitsLanded),
          dmgDealt: a.damageDealt, dmgTaken: a.damageTaken,
        })) : [],
        pendingCount:  pendingAttacks.size,
        lastMessages:  lastMsgs,
      };
      console.log('=== dc20_stats diagnose ===\n' + JSON.stringify(report, null, 2));
      return report;
    },
  };
});
