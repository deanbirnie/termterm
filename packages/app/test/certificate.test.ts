import { describe, expect, it } from 'vitest'
import { certificateMatchesKey, certificateProblem, parseCertificate } from '../src/certificate.ts'

// Made with ssh-keygen: a CA signed user.pub (and rsa.pub) as below.
const USER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH772/pAofexhCu9u+ORbNuQfo8pdQraNaAiSi7B/ahy user'
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPWYg72XTvOPpdfiwnYajxtD7rySL0XKzimh2Q1iq2R9 other'
// -I alice@example -n alice,deploy -V always:forever
const FOREVER = 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIJ4Zd/kGU6u8/HCHV4I4uDZlJKfPODZmVwIfqvYFblstAAAAIH772/pAofexhCu9u+ORbNuQfo8pdQraNaAiSi7B/ahyAAAAAAAAAAAAAAABAAAADWFsaWNlQGV4YW1wbGUAAAATAAAABWFsaWNlAAAABmRlcGxveQAAAAAAAAAA//////////8AAAAAAAAAggAAABVwZXJtaXQtWDExLWZvcndhcmRpbmcAAAAAAAAAF3Blcm1pdC1hZ2VudC1mb3J3YXJkaW5nAAAAAAAAABZwZXJtaXQtcG9ydC1mb3J3YXJkaW5nAAAAAAAAAApwZXJtaXQtcHR5AAAAAAAAAA5wZXJtaXQtdXNlci1yYwAAAAAAAAAAAAAAMwAAAAtzc2gtZWQyNTUxOQAAACBjmcglEj1Qq6WmUmTiTtTfWiSQWvCr3vTFWCDqzVb5WgAAAFMAAAALc3NoLWVkMjU1MTkAAABAMUxNi/BffS4PAwaBqE3rNw9EPlwyzyWysCZNEm5s/LOenpTUI9pgS460odFk1bOUgqgNxj5GIS6DxkCCaLA1DA== user'
// -I old -n alice -V 20200101:20200102
const EXPIRED = 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIHTuLbFEEmUErWTq46DMQnNWltfgRNjCtyWI8emDcQmhAAAAIH772/pAofexhCu9u+ORbNuQfo8pdQraNaAiSi7B/ahyAAAAAAAAAAAAAAABAAAAA29sZAAAAAkAAAAFYWxpY2UAAAAAXgvhAAAAAABeDTKAAAAAAAAAAIIAAAAVcGVybWl0LVgxMS1mb3J3YXJkaW5nAAAAAAAAABdwZXJtaXQtYWdlbnQtZm9yd2FyZGluZwAAAAAAAAAWcGVybWl0LXBvcnQtZm9yd2FyZGluZwAAAAAAAAAKcGVybWl0LXB0eQAAAAAAAAAOcGVybWl0LXVzZXItcmMAAAAAAAAAAAAAADMAAAALc3NoLWVkMjU1MTkAAAAgY5nIJRI9UKulplJk4k7U31okkFrwq970xVgg6s1W+VoAAABTAAAAC3NzaC1lZDI1NTE5AAAAQAxJDsgLZxbyfCj0V2xe0U9KR3gf/Sft/8w6vW4rd7WS6e8VU0ltmJ0JG3Hq+WsPM6nyBehNH9nYYVLcnXS5mgQ= user'
// -h (a host certificate)
const HOST = 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIL3pyGBQ7+jCZJbya3dgRsI6y/glyHtcBIpbuIDQUFcKAAAAIH772/pAofexhCu9u+ORbNuQfo8pdQraNaAiSi7B/ahyAAAAAAAAAAAAAAACAAAABGhvc3QAAAAPAAAAC2JveC5leGFtcGxlAAAAAAAAAAD//////////wAAAAAAAAAAAAAAAAAAADMAAAALc3NoLWVkMjU1MTkAAAAgY5nIJRI9UKulplJk4k7U31okkFrwq970xVgg6s1W+VoAAABTAAAAC3NzaC1lZDI1NTE5AAAAQGYULfmeu0se6iyov9hfY6DVZQCk4WKLzH8PRYVsL/3TNOPw5WyCWRvAm9aRESdIF0rX0npNt7KiIWhhtpTwbwU= user'
const RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCnmLPCkt4FbKnJJsCxxR7hbC4QpGuRCPlUwY3IhzICjzSyAjH3tpQ7l/Owa60oBP4Dmerddc37WhYL6WHDL+QREs5FQvYi8TfIj72DDLhKz5BzQfUArnN3OcIUEGgp7a5S1+DJsejGrNrfLeGXrXJBDO7K0bfzYz6/ND2YnqCoU0gSlIkQpvbqy7oBLkC6NaWU9W2BmKMzL+rC14GrCB3HRJCcLT2SJk9epG8AAcekBslkGsv2uv4TXkfsH5DYFHviTs9qJbYRM3Ybffi4wo1YT1BIasivSFPcmJQirbcij9n0yC50yP9k7QAvlSp4SE0PxwnSUlfCuvEf/j757jlZ rsa'
const RSA_CERT = 'ssh-rsa-cert-v01@openssh.com AAAAHHNzaC1yc2EtY2VydC12MDFAb3BlbnNzaC5jb20AAAAgUmZQ0S8m1f28GAH4UGFr39JQ8lGGPuIRSeseieuKpYUAAAADAQABAAABAQCnmLPCkt4FbKnJJsCxxR7hbC4QpGuRCPlUwY3IhzICjzSyAjH3tpQ7l/Owa60oBP4Dmerddc37WhYL6WHDL+QREs5FQvYi8TfIj72DDLhKz5BzQfUArnN3OcIUEGgp7a5S1+DJsejGrNrfLeGXrXJBDO7K0bfzYz6/ND2YnqCoU0gSlIkQpvbqy7oBLkC6NaWU9W2BmKMzL+rC14GrCB3HRJCcLT2SJk9epG8AAcekBslkGsv2uv4TXkfsH5DYFHviTs9qJbYRM3Ybffi4wo1YT1BIasivSFPcmJQirbcij9n0yC50yP9k7QAvlSp4SE0PxwnSUlfCuvEf/j757jlZAAAAAAAAAAAAAAABAAAAAXIAAAAJAAAABWFsaWNlAAAAAAAAAAD//////////wAAAAAAAACCAAAAFXBlcm1pdC1YMTEtZm9yd2FyZGluZwAAAAAAAAAXcGVybWl0LWFnZW50LWZvcndhcmRpbmcAAAAAAAAAFnBlcm1pdC1wb3J0LWZvcndhcmRpbmcAAAAAAAAACnBlcm1pdC1wdHkAAAAAAAAADnBlcm1pdC11c2VyLXJjAAAAAAAAAAAAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIGOZyCUSPVCrpaZSZOJO1N9aJJBa8Kve9MVYIOrNVvlaAAAAUwAAAAtzc2gtZWQyNTUxOQAAAEDKbCI+QoKoXqoNg8wXafms26Yn/u1v3+qM4iNq9p4pnD9+PdYaZDiuolq8dcIzSuyGZoHVKvL05+eOoAyy5yEB rsa'

describe('OpenSSH certificates', () => {
  it('reads a user certificate', () => {
    expect(parseCertificate(FOREVER)).toEqual({
      type: 'ssh-ed25519-cert-v01@openssh.com',
      keyType: 'ssh-ed25519',
      keyId: 'alice@example',
      principals: ['alice', 'deploy'],
      validAfter: null,
      validBefore: null,
    })
    const old = parseCertificate(EXPIRED)
    expect(old.principals).toEqual(['alice'])
    expect(old.validBefore).toBeGreaterThan(Date.UTC(2019, 11, 31))
    expect(old.validBefore).toBeLessThan(Date.UTC(2020, 0, 3))
    expect(parseCertificate(RSA_CERT).keyType).toBe('ssh-rsa')
  })

  it('matches a certificate to its own key only', () => {
    expect(certificateMatchesKey(FOREVER, USER)).toBe(true)
    expect(certificateMatchesKey(FOREVER, OTHER)).toBe(false)
    expect(certificateMatchesKey(RSA_CERT, RSA)).toBe(true)
    expect(certificateMatchesKey(RSA_CERT, USER)).toBe(false)
  })

  it('explains what is wrong', () => {
    expect(certificateProblem(FOREVER, USER)).toBeNull()
    expect(certificateProblem(FOREVER, OTHER)).toBe('This certificate is for a different key.')
    expect(certificateProblem(EXPIRED, USER)).toMatch(/^This certificate expired on /)
    expect(certificateProblem(HOST, USER)).toMatch(/host certificate/)
    expect(certificateProblem(USER, USER)).toMatch(/not an OpenSSH certificate/)
    expect(certificateProblem('ssh-ed25519-cert-v01@openssh.com AAAA', USER)).toMatch(/damaged|not an OpenSSH/)
    const cut = FOREVER.split(' ')
    expect(certificateProblem(`${cut[0]} ${cut[1]!.slice(0, 80)}`, USER)).toMatch(/damaged/)
  })
})
