# ClickUp Context: {feature-name}

**Type:** [Feature | Bug]
**Source task(s):** [task title(s)]
**Ingested:** {date}

> One block per source task. For a parent with subtasks, the parent comes first,
> then one block per deep-fetched subtask. Omit any row whose value was empty.

---

## Task: {task title}

- **ID:** {task_id}
- **URL:** {url}
- **Status:** {status}
- **Priority:** {priority}
- **Type:** {task_type or "n/a"}
- **Assignees:** {names or "n/a"}
- **Tags:** {tags or "n/a"}
- **List / Folder / Space:** {list.name} / {folder.name} / {space}

### Description
[Full `markdown_description`, verbatim. Keep the original wording. This is the
requester's intent. Replace remote `![](…clickup-attachments…)` links with
references to the locally downloaded images below.]

### Mockups / Images
| Image | Saved path | Shows |
|-------|------------|-------|
| description-1 | `clickup-images/description-1.png` | [1-line description of what it depicts] |

[If no images, write "None embedded."]

### Custom Fields
| Field | Value |
|-------|-------|
| {name} | {value} |

[Omit section if no custom fields.]

### Checklists
- [ ] {checklist item} ({complete/incomplete})

[Omit section if none.]

### Comments
**{commenter}** ({timestamp}): {comment text}
> {threaded reply commenter}: {reply text}

[Omit section if no comments. Note any images in comments in the Mockups table above.]

### Linked / Dependent Tasks
- {linked task id/name} ({relationship})

[Omit section if none.]

---

## Subtasks
[Only when the source is a parent task.]

### Deep-fetched
[Repeat the full "Task:" block above for each subtask that was deep-fetched.]

### Listed only (not deep-fetched)
| Subtask ID | Title | Status | Type |
|------------|-------|--------|------|
| {id} | {name} | {status} | {task_type} |

[Omit whichever of these two does not apply.]

---

## Ingest Summary
- Tasks ingested: {count}
- Subtasks deep-fetched: {count}
- Images downloaded: {count}
- Failed image downloads: {list URLs, or "none"}
