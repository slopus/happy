import { describe, expect, it } from 'vitest';
import { resolveCopyMenuLayoutMeasurement } from './copyMenuLayout';

describe('resolveCopyMenuLayoutMeasurement', () => {
    it('starts the menu animation after the first layout measurement', () => {
        expect(resolveCopyMenuLayoutMeasurement({
            animationStarted: false,
            measuredWidth: 184,
        })).toEqual({
            nextWidth: 184,
            shouldStartAnimation: true,
        });
    });

    it('does not restart the menu animation after subsequent layout measurements', () => {
        expect(resolveCopyMenuLayoutMeasurement({
            animationStarted: true,
            measuredWidth: 212,
        })).toEqual({
            nextWidth: 212,
            shouldStartAnimation: false,
        });
    });
});
