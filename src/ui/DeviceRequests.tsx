import { approveDevice, deviceCode, dismissDevice, useWaitingDevices } from '../state/devices'
import { useT } from './i18n'

/** Another device using our key asks for our boards: allow it, or put it off. */
export function DeviceRequests() {
  const t = useT()
  const waiting = useWaitingDevices()
  if (waiting.length === 0) return null
  return (
    <div className="device-requests">
      {waiting.map((dev) => (
        <div key={dev} className="device-request" role="alert">
          <p>
            {t('deviceAsks')} <code dir="ltr">{deviceCode(dev)}</code>
          </p>
          <button className="primary" onClick={() => approveDevice(dev)}>
            {t('deviceAllow')}
          </button>
          <button onClick={() => dismissDevice(dev)}>{t('deviceNotNow')}</button>
        </div>
      ))}
    </div>
  )
}
