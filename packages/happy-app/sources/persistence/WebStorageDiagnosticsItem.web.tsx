import * as React from 'react';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { webStorageDiagnostics, clearWebStorageCaches } from './deviceStorage.web';
export function WebStorageDiagnosticsItem() {
    const inspect = async () => {
        try { Modal.alert(t('webStorage.diagnostics'), JSON.stringify(await webStorageDiagnostics(), null, 2)); }
        catch { Modal.alert(t('common.error'), t('webStorage.failed')); }
    };
    const clear = async () => {
        if (!await Modal.confirm(t('devTools.clearCache'), t('webStorage.cacheOnly'))) return;
        try { await clearWebStorageCaches(); await inspect(); }
        catch { Modal.alert(t('common.error'), t('webStorage.failed')); }
    };
    return <ItemGroup title={t('webStorage.diagnostics')}>
        <Item title={t('webStorage.diagnostics')} onPress={() => { void inspect(); }} />
        <Item title={t('devTools.clearCache')} subtitle={t('webStorage.cacheOnly')} onPress={() => { void clear(); }} />
    </ItemGroup>;
}
