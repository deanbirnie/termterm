import { useState, type FormEvent } from 'react'
import type { SshPrompt, SshPromptReply } from '../../shared/api'
import { Button, Field, Modal } from './ui'

export function PromptDialog({
  prompt,
  onReply,
}: {
  prompt: SshPrompt
  onReply: (reply: SshPromptReply) => void
}) {
  const [values, setValues] = useState<string[]>(
    prompt.kind === 'keyboard' ? prompt.prompts.map(() => '') : [''],
  )
  const cancel = () => onReply(null)

  if (prompt.kind === 'hostkey-new') {
    return (
      <Modal title="Trust this host?" onClose={cancel}>
        <p>
          This is the first connection to <strong>{prompt.host}</strong>. Check that the
          fingerprint matches the server before continuing.
        </p>
        <pre className="fingerprint">
          {prompt.keyType}
          {'\n'}
          {prompt.fingerprint}
        </pre>
        <div className="modal-actions">
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => onReply(true)}>
            Trust and connect
          </Button>
        </div>
      </Modal>
    )
  }

  if (prompt.kind === 'hostkey-changed') {
    return (
      <Modal title="Host key has changed" tone="danger" onClose={cancel}>
        <p>
          <strong>{prompt.host}</strong> presented a different key than the one saved in your
          vault. Someone may be intercepting the connection, or the server was reinstalled.
        </p>
        <span className="field-label">Saved</span>
        <pre className="fingerprint">{prompt.known.join('\n')}</pre>
        <span className="field-label">Presented now</span>
        <pre className="fingerprint">
          {prompt.keyType} {prompt.fingerprint}
        </pre>
        <div className="modal-actions">
          <Button variant="danger" onClick={() => onReply(true)}>
            Replace saved key and connect
          </Button>
          <Button variant="primary" autoFocus onClick={cancel}>
            Disconnect
          </Button>
        </div>
      </Modal>
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onReply(prompt.kind === 'password' ? (values[0] ?? '') : values)
  }
  const fields =
    prompt.kind === 'password'
      ? [{ prompt: `Password for ${prompt.username}@${prompt.host}`, echo: false }]
      : prompt.prompts

  return (
    <Modal
      title={prompt.kind === 'password' ? 'Password required' : prompt.name || 'Authentication'}
      onClose={cancel}
    >
      <form onSubmit={submit}>
        {prompt.kind === 'password' && prompt.retry && (
          <p className="error">That did not work. Try again.</p>
        )}
        {prompt.kind === 'keyboard' && prompt.instructions && <p>{prompt.instructions}</p>}
        {fields.map((f, i) => (
          <Field key={i} label={f.prompt.replace(/:\s*$/, '')}>
            <input
              type={f.echo ? 'text' : 'password'}
              autoFocus={i === 0}
              value={values[i] ?? ''}
              onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </Field>
        ))}
        <div className="modal-actions">
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" type="submit">
            Continue
          </Button>
        </div>
      </form>
    </Modal>
  )
}
