'use strict'
const _ = require('lodash')

const CATCH_ALL = /()(.+)/gi
const SCISSOR = '# ------------------------ >8 ------------------------'

function trimOffNewlines (input) {
  return input.replace(/^(?:\r|\n)+|(?:\r|\n)+$/g, '')
}

function append (src, line) {
  if (src) {
    src += '\n' + line
  } else {
    src = line
  }

  return src
}

function getCommentFilter (char) {
  return function (line) {
    return line.charAt(0) !== char
  }
}

function truncateToScissor (lines) {
  const scissorIndex = lines.indexOf(SCISSOR)

  if (scissorIndex === -1) {
    return lines
  }

  return lines.slice(0, scissorIndex)
}

function getReferences (input, regex) {
  const references = []
  let referenceSentences
  let referenceMatch

  const reApplicable = input.match(regex.references) !== null
    ? regex.references
    : CATCH_ALL

  while ((referenceSentences = reApplicable.exec(input))) {
    const action = referenceSentences[1] || null
    const sentence = referenceSentences[2]

    while ((referenceMatch = regex.referenceParts.exec(sentence))) {
      let owner = null
      let repository = referenceMatch[1] || ''
      const ownerRepo = repository.split('/')

      if (ownerRepo.length > 1) {
        owner = ownerRepo.shift()
        repository = ownerRepo.join('/')
      }

      const reference = {
        action: action,
        owner: owner,
        repository: repository || null,
        issue: referenceMatch[3],
        raw: referenceMatch[0],
        prefix: referenceMatch[2]
      }

      references.push(reference)
    }
  }

  return references
}

function passTrough () {
  return true
}

function parser (raw, options, regex) {
  if (!raw || !raw.trim()) {
    throw new TypeError('Expected a raw commit')
  }

  if (_.isEmpty(options)) {
    throw new TypeError('Expected options')
  }

  if (_.isEmpty(regex)) {
    throw new TypeError('Expected regex')
  }

  let currentProcessedField
  let mentionsMatch
  const otherFields = {}
  const commentFilter = typeof options.commentChar === 'string'
    ? getCommentFilter(options.commentChar)
    : passTrough
  const gpgFilter = line => !line.match(/^\s*gpg:/)

  const rawLines = trimOffNewlines(raw).split(/\r?\n/)
  const lines = truncateToScissor(rawLines).filter(commentFilter).filter(gpgFilter)

  let continueNote = false
  let isBody = true
  const headerCorrespondence = _.map(options.headerCorrespondence, function (part) {
    return part.trim()
  })
  const revertCorrespondence = _.map(options.revertCorrespondence, function (field) {
    return field.trim()
  })
  const mergeCorrespondence = _.map(options.mergeCorrespondence, function (field) {
    return field.trim()
  })

  let body = null
  let footer = null
  let header = null
  const mentions = []
  let merge = null
  const notes = []
  const references = []
  let revert = null

  if (lines.length === 0) {
    return {
      body: body,
      footer: footer,
      header: header,
      mentions: mentions,
      merge: merge,
      notes: notes,
      references: references,
      revert: revert,
      scope: null,
      subject: null,
      type: null
    }
  }

  // msg parts
  merge = lines.shift()
  const mergeParts = {}
  const headerParts = {}
  body = ''
  footer = ''

  const mergeMatch = merge.match(options.mergePattern)
  if (mergeMatch && options.mergePattern) {
    merge = mergeMatch[0]

    header = lines.shift()
    while (header !== undefined && !header.trim()) {
      header = lines.shift()
    }
    if (!header) {
      header = ''
    }

    _.forEach(mergeCorrespondence, function (partName, index) {
      const partValue = mergeMatch[index + 1] || null
      mergeParts[partName] = partValue
    })
  } else {
    header = merge
    merge = null

    _.forEach(mergeCorrespondence, function (partName) {
      mergeParts[partName] = null
    })
  }

  const headerMatch = header.match(options.headerPattern)
  if (headerMatch) {
    _.forEach(headerCorrespondence, function (partName, index) {
      const partValue = headerMatch[index + 1] || null
      headerParts[partName] = partValue
    })
  } else {
    _.forEach(headerCorrespondence, function (partName) {
      headerParts[partName] = null
    })
  }

  Array.prototype.push.apply(references, getReferences(header, {
    references: regex.references,
    referenceParts: regex.referenceParts
  }))

  // body or footer
  _.forEach(lines, function (line) {
    if (options.fieldPattern) {
      const fieldMatch = options.fieldPattern.exec(line)

      if (fieldMatch) {
        currentProcessedField = fieldMatch[1]

        return
      }

      if (currentProcessedField) {
        otherFields[currentProcessedField] = append(otherFields[currentProcessedField], line)

        return
      }
    }

    let referenceMatched

    // this is a new important note
    const notesMatch = line.match(regex.notes)
    if (notesMatch) {
      continueNote = true
      isBody = false
      footer = append(footer, line)

      const note = {
        title: notesMatch[1],
        text: notesMatch[2]
      }

      notes.push(note)

      return
    }

    const lineReferences = getReferences(line, {
      references: regex.references,
      referenceParts: regex.referenceParts
    })

    if (lineReferences.length > 0) {
      isBody = false
      referenceMatched = true
      continueNote = false
    }

    Array.prototype.push.apply(references, lineReferences)

    if (referenceMatched) {
      footer = append(footer, line)

      return
    }

    if (continueNote) {
      notes[notes.length - 1].text = append(notes[notes.length - 1].text, line)
      footer = append(footer, line)

      return
    }

    if (isBody) {
      body = append(body, line)
    } else {
      footer = append(footer, line)
    }
  })

  if (options.breakingHeaderPattern && notes.length === 0) {
    const breakingHeader = header.match(options.breakingHeaderPattern)
    if (breakingHeader) {
      const noteText = breakingHeader[3] // the description of the change.
      notes.push({
        title: 'BREAKING CHANGE',
        text: noteText
      })
    }
  }

  while ((mentionsMatch = regex.mentions.exec(raw))) {
    mentions.push(mentionsMatch[1])
  }

  // does this commit revert any other commit?
  const revertMatch = raw.match(options.revertPattern)
  if (revertMatch) {
    revert = {}
    _.forEach(revertCorrespondence, function (partName, index) {
      const partValue = revertMatch[index + 1] || null
      revert[partName] = partValue
    })
  } else {
    revert = null
  }

  _.map(notes, function (note) {
    note.text = trimOffNewlines(note.text)

    return note
  })

  const msg = _.merge(headerParts, mergeParts, {
    merge: merge,
    header: header,
    body: body ? trimOffNewlines(body) : null,
    footer: footer ? trimOffNewlines(footer) : null,
    notes: notes,
    references: references,
    mentions: mentions,
    revert: revert
  }, otherFields)

  return msg
}

module.exports = parser
