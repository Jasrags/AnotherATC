import { describe, it, expect } from 'vitest'
import { isTypingTarget } from './keyboard'

describe('isTypingTarget', () => {
  it('is true for form fields', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true)
  })

  it('is true for a contenteditable element', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
  })

  it('is false for non-editable elements and null', () => {
    expect(isTypingTarget({ tagName: 'CANVAS' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
