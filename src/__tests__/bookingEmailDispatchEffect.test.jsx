import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import BookingEmailDispatchEffect from '../components/BookingEmailDispatchEffect';

const stored = { bookingId: 'booking.fixture', emailDispatchToken: 'fixture-confirmation-token' };
const mount = () => render(<MemoryRouter><BookingEmailDispatchEffect /></MemoryRouter>);

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  jest.restoreAllMocks();
});

test('inactive confirmation clears stored work and cannot retry after remount', async () => {
  sessionStorage.setItem('booking_confirmation_state', JSON.stringify(stored));
  jest.spyOn(global, 'fetch').mockResolvedValue({ status: 409, json: async () => ({
    ok: false, code: 'booking_inactive', retryable: false,
    emailDispatch: { allSent: false, client: { sent: false }, owner: { sent: false } },
  }) });
  const view = mount();
  await waitFor(() => expect(sessionStorage.getItem('booking_confirmation_state')).toBeNull());
  view.unmount();
  mount();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('an unrelated conflict retains stored work for another visit', async () => {
  sessionStorage.setItem('booking_confirmation_state', JSON.stringify(stored));
  jest.spyOn(global, 'fetch').mockResolvedValue({ status: 409, json: async () => ({
    ok: false, code: 'email_dispatch_lease_changed', retryable: true,
  }) });
  const view = mount();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(sessionStorage.getItem('booking_confirmation_state')).toBe(JSON.stringify(stored));
  view.unmount();
  mount();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

test('inactive confirmation is also removed from navigation state before remount', async () => {
  const Probe = () => <output>{JSON.stringify(useLocation().state)}</output>;
  const Wrapper = ({ show }) => <MemoryRouter initialEntries={[{ pathname: '/thank-you',
    state: { bookingConfirmation: stored, retained: 'value' } }]}>
    {show && <BookingEmailDispatchEffect />}<Probe />
  </MemoryRouter>;
  jest.spyOn(global, 'fetch').mockResolvedValue({ status: 409, json: async () => ({
    ok: false, code: 'booking_inactive', retryable: false,
  }) });
  const view = render(<Wrapper show />);
  await waitFor(() => expect(view.getByRole('status').textContent).toBe('{"retained":"value"}'));
  view.rerender(<Wrapper show={false} />);
  view.rerender(<Wrapper show />);
  expect(fetch).toHaveBeenCalledTimes(1);
});
