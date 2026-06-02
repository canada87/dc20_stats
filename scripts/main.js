const MODULE_ID = 'dc20-combat-stats';

// ── State ─────────────────────────────────────────────────────────────────────

let stats = null;

// targetTokenId → { sourceActorId, sourceName }
// Populated from attack cards (Card 1) so Card 2 can attribute damage to the attacker.
const pendingAttacks = new Map();

// ── Stats helpers ─────────────────────────────────────────────────────────────

function resetStats(combat) {
  stats = {
    combatId: combat.id,
    name: combat.name || 'Combat',
    rounds: combat.round ?? 0,
    actors: {},      // actorId → ActorEntry
    messageMap: {},  // messageId → recorded event (for revert support)
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
      damageDealt: 0,
      damageTaken: 0,
      healingDone: 0,
      healingReceived: 0,
    };
  }
  return stats.actors[actorId];
}

// ── Message parsing ───────────────────────────────────────────────────────────

// Card 1: attack/spell card sent by the attacker, has DC20 item flags and target data.
function isAttackCard(msg) {
  return !!msg.flags?.dc20rpg?.itemId;
}

// Card 2: the confirmation message after damage/healing is applied.
// DC20 always adds the 'revert-name' CSS class to these messages.
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

// Extract all unique target token IDs from the attack card HTML.
// DC20 puts data-target="TOKEN_ID" on the apply-damage buttons.
function extractTargetTokenIds(content) {
  const matches = [...content.matchAll(/data-target="([^"#]+)"/g)];
  return [...new Set(matches.map(m => m[1]))];
}

// ── Hook handlers ─────────────────────────────────────────────────────────────

function onCreateChatMessage(msg) {
  if (!stats) return;

  const content = msg.content ?? '';

  // Card 1 – remember attacker for each target token so Card 2 can attribute correctly.
  if (isAttackCard(msg)) {
    const source = { sourceActorId: msg.speaker.actor, sourceName: msg.speaker.alias };
    extractTargetTokenIds(content).forEach(tid => pendingAttacks.set(tid, source));
    return;
  }

  if (!isConfirmationMessage(content)) return;

  const parsed = parseConfirmation(content);
  if (!parsed) return;

  // Target = whoever the confirmation message was sent for (the one who took dmg/healing).
  const targetActorId = msg.speaker.actor;
  const targetActor = game.actors.get(targetActorId);
  if (!targetActor || targetActor.type === 'storage') return;

  // Source = attacker/healer, looked up from Card 1 data, with combat turn as fallback.
  const pending = pendingAttacks.get(msg.speaker.token);
  const sourceActorId = pending?.sourceActorId ?? game.combat?.combatant?.actorId;
  const sourceName    = pending?.sourceName    ?? game.combat?.combatant?.name;

  // Update target.
  const targetEntry = getOrCreateActor(targetActorId, msg.speaker.alias, targetActor.type);
  if (parsed.type === 'damage') targetEntry.damageTaken     += parsed.amount;
  else                          targetEntry.healingReceived += parsed.amount;

  // Update source (only if it exists and isn't storage).
  let sourceActorEntry = null;
  if (sourceActorId) {
    const sourceActor = game.actors.get(sourceActorId);
    if (sourceActor && sourceActor.type !== 'storage') {
      sourceActorEntry = getOrCreateActor(sourceActorId, sourceName, sourceActor.type);
      if (parsed.type === 'damage') sourceActorEntry.damageDealt += parsed.amount;
      else                          sourceActorEntry.healingDone += parsed.amount;
    }
  }

  // Store for potential revert.
  stats.messageMap[msg.id] = { ...parsed, targetActorId, sourceActorId };

  // Refresh dialog if open.
  statsDialog?.rendered && statsDialog.render();
}

function onDeleteChatMessage(msg) {
  if (!stats) return;
  const record = stats.messageMap[msg.id];
  if (!record) return;

  const { type, amount, targetActorId, sourceActorId } = record;

  const target = stats.actors[targetActorId];
  if (target) {
    if (type === 'damage') target.damageTaken     = Math.max(0, target.damageTaken     - amount);
    else                   target.healingReceived = Math.max(0, target.healingReceived - amount);
  }

  if (sourceActorId) {
    const source = stats.actors[sourceActorId];
    if (source) {
      if (type === 'damage') source.damageDealt = Math.max(0, source.damageDealt - amount);
      else                   source.healingDone = Math.max(0, source.healingDone - amount);
    }
  }

  delete stats.messageMap[msg.id];
  statsDialog?.rendered && statsDialog.render();
}

function onUpdateCombat(combat, changed) {
  if (!stats || combat.id !== stats.combatId) return;
  if (changed.round !== undefined) stats.rounds = changed.round;
}

// ── Dialog ────────────────────────────────────────────────────────────────────

class CombatStatsDialog extends Application {
  static get defaultOptions() {
    return {
      ...super.defaultOptions,
      id: 'dc20-combat-stats-dialog',
      title: 'DC20 — Combat Statistics',
      template: `modules/${MODULE_ID}/templates/stats-dialog.hbs`,
      width: 680,
      height: 'auto',
      resizable: true,
    };
  }

  getData() {
    if (!stats) return { hasStats: false };

    const all    = Object.values(stats.actors);
    const party  = all.filter(a => a.type === 'character' || a.type === 'companion');
    const enemies = all.filter(a => a.type === 'npc');
    const rounds  = Math.max(1, stats.rounds);

    const totalDealt   = party.reduce((s, a) => s + a.damageDealt,   0);
    const totalTaken   = party.reduce((s, a) => s + a.damageTaken,   0);
    const totalHealing = party.reduce((s, a) => s + a.healingDone,   0);

    return {
      hasStats: true,
      name:     stats.name,
      rounds:   stats.rounds,
      party: party.map(a => ({
        ...a,
        avgDmgPerRound: (a.damageDealt / rounds).toFixed(1),
      })),
      enemies,
      summary: {
        enemyCount:    enemies.length,
        totalDealt,
        totalTaken,
        totalHealing,
        avgDmgPerEnemy: enemies.length ? (totalDealt / enemies.length).toFixed(1) : '—',
      },
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="export"]').on('click', () => exportToTxt());
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
  lines.push(col('Name', 22) + col('Type', 12) + col('Dmg Dealt', 12) + col('Avg/Round', 12) + col('Dmg Taken', 12) + col('Healed', 10) + 'Recv. Heal');
  lines.push('-'.repeat(92));
  party.forEach(a => {
    lines.push(
      col(a.name, 22) +
      col(a.type, 12) +
      col(a.damageDealt, 12) +
      col((a.damageDealt / rounds).toFixed(1), 12) +
      col(a.damageTaken, 12) +
      col(a.healingDone, 10) +
      a.healingReceived
    );
  });

  if (enemies.length) {
    lines.push('');
    lines.push('--- ENEMIES -----------------------------------------------------');
    lines.push(col('Name', 34) + col('Dmg Taken', 12) + 'Recv. Heal');
    lines.push('-'.repeat(58));
    enemies.forEach(a => {
      lines.push(col(a.name, 34) + col(a.damageTaken, 12) + a.healingReceived);
    });
  }

  lines.push('');
  lines.push('--- SUMMARY -----------------------------------------------------');
  lines.push(`Total damage dealt by party : ${totalDealt}`);
  lines.push(`Total damage taken by party : ${totalTaken}`);
  lines.push(`Total healing done by party : ${totalHealing}`);
  lines.push(`Avg damage per enemy        : ${enemies.length ? (totalDealt / enemies.length).toFixed(1) : '—'}`);

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
  if (!statsDialog || !statsDialog.rendered) statsDialog = new CombatStatsDialog();
  statsDialog.render(true);
}

Hooks.once('ready', () => {
  console.log(`${MODULE_ID} | ready`);

  Hooks.on('combatStart',       combat           => { resetStats(combat); ui.notifications.info('DC20 Stats: tracking started.'); });
  Hooks.on('deleteCombat',      combat           => { if (stats?.combatId === combat.id) openStatsDialog(); });
  Hooks.on('updateCombat',      onUpdateCombat);
  Hooks.on('createChatMessage', onCreateChatMessage);
  Hooks.on('deleteChatMessage', onDeleteChatMessage);

  // Button in the combat tracker header.
  Hooks.on('renderCombatTracker', (_app, html) => {
    if (!game.combat) return;
    const btn = $(`<a class="combat-control" title="Combat Statistics" style="font-size:1rem;"><i class="fa-solid fa-chart-bar"></i></a>`);
    btn.on('click', openStatsDialog);
    html.find('.combat-controls').prepend(btn);
  });

  // Expose to macros / console.
  game.dc20CombatStats = {
    open:     openStatsDialog,
    export:   exportToTxt,
    getStats: () => stats,
  };
});
