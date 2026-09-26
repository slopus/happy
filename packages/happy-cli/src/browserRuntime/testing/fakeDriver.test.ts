import { describe, expect, it } from 'vitest'
import { FakeBrowserDriver } from './fakeDriver'

describe('FakeBrowserDriver snapshot rules', () => {
    it('invalidates the previous ref snapshot whenever a new observation is made', async () => {
        const driver = new FakeBrowserDriver()
        const tab = await driver.openTab('https://fixture.test/start', ['https://fixture.test'], { timeoutMs: 1000 })
        const first = await driver.observe(tab.tabId, ['https://fixture.test'], { timeoutMs: 1000 })
        await driver.observe(tab.tabId, ['https://fixture.test'], { timeoutMs: 1000 })

        await expect(driver.click(tab.tabId, '@button' as never, first.snapshotId, { timeoutMs: 1000 }))
            .rejects.toMatchObject({ code: 'STALE_REF' })
    })

    it('describes refs without taking a new snapshot and rejects a replaced node', async () => {
        const driver = new FakeBrowserDriver()
        const tab = await driver.openTab('https://fixture.test/start', ['https://fixture.test'], { timeoutMs: 1000 })
        driver.seedTab(tab.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@button' as never, role: 'button', name: 'Continue', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        const observation = await driver.observe(tab.tabId, ['https://fixture.test'], { timeoutMs: 1000 })
        const described = await driver.describeRef!(tab.tabId, '@button' as never, observation.snapshotId,
            { timeoutMs: 1000 })
        expect(described.name).toBe('Continue')
        expect(driver.observeCount).toBe(1)

        driver.seedTab(tab.tabId, { url: 'https://fixture.test/start', elements: [
            { ref: '@button' as never, role: 'button', name: 'Decoy', visible: true,
                frameOrigin: 'https://fixture.test' },
        ] })
        await expect(driver.describeRef!(tab.tabId, '@button' as never, observation.snapshotId, { timeoutMs: 1000 }))
            .rejects.toMatchObject({ code: 'STALE_REF' })
        expect(driver.observeCount).toBe(1)
    })
})
