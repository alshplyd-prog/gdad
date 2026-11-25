// Capacitor Background Runner Worker script
// Runs in a headless background JS runtime on mobile devices (Android / iOS)

addEventListener('syncOfflineQueue', async (resolve, _reject, _args) => {
  try {
    console.log('[BackgroundRunner] Woke up to check and sync offlineQueue...');

    // 1. Read stored server config (both http and https) or use candidate cloud servers
    let candidateServers = [
      'http://72.62.158.128',
      'http://72.62.158.128:3000',
      'https://ais-dev-asc5xuvnur4hlmpl5rfxpz-655986077616.europe-west2.run.app',
      'https://ais-pre-asc5xuvnur4hlmpl5rfxpz-655986077616.europe-west2.run.app',
    ];
    if (typeof CapacitorKV !== 'undefined') {
      for (const key of ['alkarrar_backend_server_url', 'alkarrar_custom_server_url']) {
        try {
          const custom = await CapacitorKV.get(key);
          if (
            custom &&
            typeof custom === 'string' &&
            (custom.startsWith('https://') || custom.startsWith('http://')) &&
            !custom.includes('localhost') &&
            !custom.includes('127.0.0.1')
          ) {
            const normalized = custom.trim().replace(/\/+$/, '');
            if (!candidateServers.includes(normalized)) {
              candidateServers.unshift(normalized);
            }
          }
        } catch (e) {}
      }
    }

    let queue = [];
    if (typeof CapacitorKV !== 'undefined') {
      try {
        const raw = await CapacitorKV.get('alkarrar_offline_pending_queue');
        if (raw && typeof raw === 'string') {
          queue = JSON.parse(raw);
        }
      } catch (e) {
        console.warn('[BackgroundRunner] CapacitorKV read error:', e);
      }
    }

    if (!Array.isArray(queue) || queue.length === 0) {
      return resolve({ status: 'no_pending_items', syncedCount: 0 });
    }

    const pendingActions = queue.filter(
      (item) => item && item.status !== 'synced' && !item.id?.startsWith('__meta_') && item.type !== '__META_CONFIG__'
    );
    if (pendingActions.length === 0) {
      return resolve({ status: 'no_pending_items', syncedCount: 0 });
    }

    console.log(`[BackgroundRunner] Uploading ${pendingActions.length} pending items...`);
    const processedSet = new Set();

    // Path 1: Batch sync in reliable slices of 25 items
    let activeWorkingServer = candidateServers[0];
    const CHUNK_SIZE = 25;
    for (let b = 0; b < pendingActions.length; b += CHUNK_SIZE) {
      const slice = pendingActions.slice(b, b + CHUNK_SIZE);
      for (const sUrl of candidateServers) {
        try {
          const batchResp = await fetch(`${sUrl}/api/sync/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ actions: slice, timestamp: Date.now() }),
          });
          if (batchResp && batchResp.ok) {
            const ct = (batchResp.headers?.get('content-type') || '').toLowerCase();
            if (ct.includes('text/html')) continue;
            activeWorkingServer = sUrl;
            const batchJson = await batchResp.json().catch(() => ({}));
            if (Array.isArray(batchJson.processedIds)) {
              for (const id of batchJson.processedIds) processedSet.add(id);
            } else if (batchJson.success) {
              for (const a of slice) processedSet.add(a.id);
            }
            if (Array.isArray(batchJson.rejectedReplayIds)) {
              for (const id of batchJson.rejectedReplayIds) processedSet.add(id);
            }
            break;
          }
        } catch (bErr) {
          console.warn('[BackgroundRunner] Batch sync notice for ' + sUrl + ':', bErr);
        }
      }
    }

    // Path 2: Individual REST endpoints fallback for any remaining items
    const remainingActions = pendingActions.filter((a) => !processedSet.has(a.id));
    for (const action of remainingActions) {
      try {
        const { type, payload } = action;
        if (!payload) {
          processedSet.add(action.id);
          continue;
        }

        let table = '';
        let method = 'POST';
        const docId = typeof payload === 'string' ? payload : payload.id || payload.contractId;

        if (type.includes('CONTRACT')) table = 'contracts';
        else if (type.includes('PAYMENT') && !type.includes('CONFLICT')) table = 'payments';
        else if (type.includes('INVENTORY')) table = 'inventory';
        else if (type.includes('REP')) table = 'reps';
        else if (type.includes('FUND_TX') || type.includes('FUND_TRANSACTION')) table = 'fund-transactions';
        else if (type === 'REORDER_FUNDS') {
          table = 'funds/reorder';
        } else if (type.includes('FUND')) table = 'funds';
        else if (type === 'REORDER_CUSTOMER_LISTS') {
          table = 'customer-lists/reorder';
        } else if (type.includes('CUSTOMER_LIST')) table = 'customer-lists';
        else if (type.includes('EMPLOYEE_TX') || type.includes('EMPLOYEE_TRANSACTION')) table = 'employee-transactions';
        else if (type.includes('EMPLOYEE')) table = 'employees';
        else if (type.includes('CONFLICT')) table = 'payment-conflicts';
        else if (type.includes('APPOINTMENT')) table = 'appointments';

        if (!table) continue;

        const isDelete = type.startsWith('DELETE_') || type.startsWith('RESOLVE_') || type.startsWith('REJECT_');
        const isUpdate = type.startsWith('UPDATE_') && !type.includes('REORDER');
        let url = `${activeWorkingServer}/api/${table}`;
        if (isDelete && docId) {
          url += `/${encodeURIComponent(docId)}`;
          method = 'DELETE';
        } else if (isUpdate && docId) {
          url += `/${encodeURIComponent(docId)}`;
          method = 'PUT';
        }

        const resp = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: !isDelete ? JSON.stringify(payload) : undefined,
        });
        if (resp && ((resp.ok && resp.status < 400) || (method === 'DELETE' && resp.status === 404))) {
          processedSet.add(action.id);
        }
      } catch (err) {
        console.warn('[BackgroundRunner] Item upload error:', err);
      }
    }

    if (processedSet.size > 0 && typeof CapacitorKV !== 'undefined') {
      try {
        const updatedQueue = queue.filter((item) => item && !processedSet.has(item.id));
        await CapacitorKV.set('alkarrar_offline_pending_queue', JSON.stringify(updatedQueue));
      } catch (e) {}
    }

    console.log(`[BackgroundRunner] Finished background sync. Uploaded ${processedSet.size} items.`);
    resolve({ status: 'success', syncedCount: processedSet.size });
  } catch (globalErr) {
    console.error('[BackgroundRunner] Global sync error:', globalErr);
    resolve({ status: 'error', error: String(globalErr) });
  }
});
