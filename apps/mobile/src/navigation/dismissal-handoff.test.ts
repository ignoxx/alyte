import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffAfterAppearance, type ClosingTransitionEvent } from './dismissal-handoff';

test('root navigation waits for the native closing transition and runs only once', () => {
  let listener: ((event: ClosingTransitionEvent) => void) | undefined;
  let destinations = 0;
  let unsubscribes = 0;

  handoffAfterAppearance(
    {
      addListener: (_event, nextListener) => {
        listener = nextListener;
        return () => {
          unsubscribes += 1;
        };
      },
    },
    () => {
      destinations += 1;
    },
  );

  assert.equal(destinations, 0, 'a frame callback is too early while the form sheet is closing');
  listener?.({ data: { closing: true } });
  assert.equal(destinations, 0, 'the sheet closing event must not trigger the destination');
  listener?.({ data: { closing: false } });
  listener?.({ data: { closing: false } });
  assert.equal(destinations, 1);
  assert.equal(unsubscribes, 1);
});
