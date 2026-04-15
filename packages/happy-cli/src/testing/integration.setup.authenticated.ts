import { installIntegrationEnvironment } from './installIntegrationEnvironment';

await installIntegrationEnvironment({
    template: 'authenticated-empty',
    up: true,
});
