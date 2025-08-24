// Gestion des critères du modal de sélection matière

// Déclaration des règles
const rules = {
    exclusives: [
        ["rigidite_elevee", "flexibilite"],
        ["transparence", "charge_fibre"]
    ],
    conflicts: {
        transparence: {
            hard: ["retardateur_flamme"],
            soft: ["texture_possible"]
        }
    },
    limits: {
        mecanique: 3,
        esthetique: 2,
        reglementaire: 1
    },
    regStrong: ["alimentaire", "medicale", "retardateur_flamme", "electrique"]
};

// Mapping exclusifs pour accès rapide
const exclusiveMap = {};
rules.exclusives.forEach(([a, b]) => {
    exclusiveMap[a] = (exclusiveMap[a] || []).concat(b);
    exclusiveMap[b] = (exclusiveMap[b] || []).concat(a);
});

const state = {
    warnings: new Set(),
    blockers: new Set()
};

function showToast(message) {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.innerHTML = `<div class="toast-body">${message}</div>`;
    container.appendChild(toastEl);
    const toast = new bootstrap.Toast(toastEl);
    toast.show();
    toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
}

function addWarningBadge(id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label && !label.querySelector(".warn-badge")) {
        const span = document.createElement("span");
        span.className = "warn-badge badge text-bg-warning ms-2";
        span.textContent = "⚠️";
        label.appendChild(span);
    }
}

function removeWarningBadge(id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (!label) return;
    const badge = label.querySelector(".warn-badge");
    if (badge) badge.remove();
}

function exceedsSectionLimit(cb) {
    const section = cb.dataset.section;
    const limit = rules.limits[section];
    if (!limit) return false;
    const checked = document.querySelectorAll(`.criterion[data-section="${section}"]:checked`);
    if (checked.length > limit) {
        showToast("Max atteint dans cette section");
        return true;
    }
    if (section === "reglementaire" && rules.regStrong.includes(cb.id)) {
        const strongChecked = Array.from(checked).filter(x => rules.regStrong.includes(x.id));
        if (strongChecked.length > rules.limits.reglementaire) {
            showToast("Max atteint dans cette section");
            return true;
        }
    }
    return false;
}

function checkHardConflicts(id) {
    const allConflicts = [];
    const direct = rules.conflicts[id]?.hard || [];
    allConflicts.push(...direct);
    for (const [k, v] of Object.entries(rules.conflicts)) {
        if (v.hard && v.hard.includes(id)) allConflicts.push(k);
    }
    for (const otherId of allConflicts) {
        const other = document.getElementById(otherId);
        if (other && other.checked) {
            showToast(`Conflit avec ${otherId.replace(/_/g, " ")}`);
            return false;
        }
    }
    return true;
}

function applyExclusives(id, checked) {
    const targets = exclusiveMap[id] || [];
    targets.forEach(tid => {
        const other = document.getElementById(tid);
        if (!other) return;
        if (checked) {
            other.checked = false;
            other.disabled = true;
        } else {
            other.disabled = false;
        }
    });
}

function evaluate() {
    state.warnings.clear();
    state.blockers.clear();
    document.querySelectorAll("label .warn-badge").forEach(b => b.remove());
    const checked = Array.from(document.querySelectorAll(".criterion:checked")).map(cb => cb.id);

    checked.forEach(id => {
        const conf = rules.conflicts[id];
        if (!conf) return;
        (conf.hard || []).forEach(other => {
            if (checked.includes(other)) {
                state.blockers.add(id);
                state.blockers.add(other);
            }
        });
        (conf.soft || []).forEach(other => {
            if (checked.includes(other)) {
                state.warnings.add(id);
                state.warnings.add(other);
                addWarningBadge(id);
                addWarningBadge(other);
            }
        });
    });

    updateSummary(checked);
    const btn = document.getElementById("analyserBtn");
    if (btn) btn.disabled = state.blockers.size > 0;
}

function updateSummary(checked) {
    const valid = checked.filter(id => !state.warnings.has(id) && !state.blockers.has(id));
    fillList("summaryValid", valid);
    fillList("summaryWarnings", Array.from(state.warnings));
    fillList("summaryBlockers", Array.from(state.blockers));
}

function fillList(id, items) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = "";
    items.forEach(it => {
        const li = document.createElement("li");
        li.textContent = it.replace(/_/g, " ");
        el.appendChild(li);
    });
}

function handleChange(e) {
    const cb = e.target;
    if (cb.checked) {
        if (exceedsSectionLimit(cb)) {
            cb.checked = false;
            return;
        }
        if (!checkHardConflicts(cb.id)) {
            cb.checked = false;
            return;
        }
        applyExclusives(cb.id, true);
        const soft = rules.conflicts[cb.id]?.soft || [];
        soft.forEach(otherId => {
            const other = document.getElementById(otherId);
            if (other && other.checked) {
                showToast(`Avertissement: ${cb.id.replace(/_/g, " ")} et ${otherId.replace(/_/g, " ")}`);
            }
        });
    } else {
        applyExclusives(cb.id, false);
    }
    evaluate();
}

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".criterion").forEach(cb => {
        cb.addEventListener("change", handleChange);
    });
    evaluate();
});
