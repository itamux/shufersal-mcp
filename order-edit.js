import { mkdir, open, lstat, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OrderCareError } from './order-care.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const editingOrder = () => {
  const value = window.miglog?.cart?.order;
  return typeof value === 'string' ? value : typeof value?.code === 'string' ? value.code : null;
};

// Only shopping projections enter this file; never browser state or credentials.
export async function backupOrderEdit(env, data) {
  const directory = env.SHUFERSAL_BACKUP_DIR || join(homedir(), '.local', 'state', 'shufersal-mcp', 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new OrderCareError('Order backup directory must be a private directory (mode 0700). No edit started.');
  }
  const id = randomUUID(), path = join(directory, `${id}.json`);
  const payload = { version: 1, id, capturedAt: new Date().toISOString(), ...data };
  const bytes = JSON.stringify(payload, null, 2) + '\n';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  if (createHash('sha256').update(await readFile(path)).digest('hex') !== sha256) {
    throw new OrderCareError('Order backup verification failed. No edit started.');
  }
  return { id, path, sha256 };
}

// Compare identifiers and quantities; selling methods may differ between the
// purchased order and edit cart. Preserve both methods instead of guessing.
export function compareOrderCart(order, cart) {
  const before = new Map(), after = new Map();
  for (const item of order.items) before.set(item.productCode, (before.get(item.productCode) || 0) + item.quantity);
  for (const item of cart.items) after.set(item.productCode, (after.get(item.productCode) || 0) + item.quantity);
  return {
    differences: [...new Set([...before.keys(), ...after.keys()])].flatMap(productCode => {
      const orderedQuantity = before.get(productCode) || 0, cartQuantity = after.get(productCode) || 0;
      return Math.abs(orderedQuantity - cartQuantity) <= 0.0001 ? [] : [{ productCode, orderedQuantity, cartQuantity }];
    }),
    note: 'Order rows can include delivery/service charges absent from the edit cart. Differences are not automatically shortages. Use the edit cart selling method for changes; order methods can differ.',
  };
}
