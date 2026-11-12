
    const API_ENDPOINT = "/api/proxy";

    const session = (() => {
      try {
        return JSON.parse(localStorage.getItem("billing_session") || "null");
      } catch (error) {
        return null;
      }
    })();
    if (!session || session.role !== "admin" || !session.token) {
      window.location.href = "index.html";
    }

    const el = {
      adminWelcome: document.getElementById("adminWelcome"),
      totalPelangganValue: document.getElementById("totalPelangganValue"),
      totalAktifValue: document.getElementById("totalAktifValue"),
      totalIsolirValue: document.getElementById("totalIsolirValue"),
      ticketList: document.getElementById("ticketList"),
      broadcastForm: document.getElementById("broadcastForm"),
      broadcastMessage: document.getElementById("broadcastMessage"),
      broadcastFeedback: document.getElementById("broadcastFeedback"),
      refreshButton: document.getElementById("refreshButton"),
      logoutButton: document.getElementById("logoutButton")
    };

    function formatCurrency(value) {
      return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0
      }).format(Number(value || 0));
    }

    function formatDate(value) {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(date);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    }

    function payPillClass(status) {
      const s = String(status || "").toUpperCase();
      if (["LUNAS", "PAID", "SETTLEMENT", "SUCCESS", "BERHASIL"].includes(s)) return "paid";
      if (["PENDING", "MENUNGGU", "BELUM DIBAYAR", "UNPAID"].includes(s)) return "pending";
      if (["GAGAL", "EXPIRE", "EXPIRED", "CANCEL"].includes(s)) return "open";
      return "other";
    }

    async function postJson(payload) {
      if (!session || session.role !== "admin" || !session.token) {
        throw new Error("Sesi berakhir. Silakan login kembali.");
      }
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...payload, token: session.token })
      });
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || "Permintaan gagal.");
      }
      return result;
    }

    function setFeedback(message, type) {
      el.broadcastFeedback.textContent = message;
      el.broadcastFeedback.className = "feedback" + (type ? " " + type : "");
    }

    function renderTickets(tickets) {
      if (!tickets.length) {
        el.ticketList.innerHTML = '<div class="empty-state">Belum ada tiket keluhan.</div>';
        return;
      }

      el.ticketList.innerHTML = tickets.map((ticket) => {
        const done = String(ticket.status || "").toUpperCase() === "SELESAI";
        return `
          <article class="ticket">
            <div class="ticket-header">
              <div>
                <strong>${escapeHtml(ticket.idTiket)}</strong>
                <div class="muted">${escapeHtml(ticket.nama)} • ${escapeHtml(ticket.idPelanggan)} • ${escapeHtml(formatDate(ticket.tgl))}</div>
              </div>
              <span class="pill ${done ? "done" : "open"}">${escapeHtml(ticket.status)}</span>
            </div>
            <p>${escapeHtml(ticket.pesan)}</p>
            ${done ? "" : `<button class="button button-success" type="button" data-ticket="${escapeHtml(ticket.idTiket)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Tandai Selesai</button>`}
          </article>
        `;
      }).join("");

      el.ticketList.querySelectorAll("[data-ticket]").forEach((button) => {
        button.addEventListener("click", async () => {
          try {
            await postJson({
              action: "updateStatusKeluhan",
              idTiket: button.dataset.ticket
            });
            await loadDashboard();
          } catch (error) {
            alert(error.message || "Gagal mengubah status keluhan.");
          }
        });
      });
    }

    function renderAdmin(data) {
      el.adminWelcome.textContent = `${session.nama} • role admin`;
      el.totalPelangganValue.textContent = data.statistik.totalPelanggan;
      el.totalAktifValue.textContent = data.statistik.aktif;
      el.totalIsolirValue.textContent = data.statistik.terisolir;
      renderTickets(data.keluhan || []);
    }

    async function loadDashboard() {
      try {
        const result = await postJson({ action: "dashboardAdmin" });
        renderAdmin(result.data);
      } catch (error) {
        alert(error.message || "Gagal memuat dashboard admin.");
      }
    }

    async function handleBroadcast(event) {
      event.preventDefault();
      const pesan = el.broadcastMessage.value.trim();

      if (!pesan) {
        setFeedback("Pesan broadcast wajib diisi.", "error");
        return;
      }

      try {
        await postJson({
          action: "updateBroadcast",
          pesan: pesan
        });
        setFeedback("Broadcast berhasil diperbarui.", "success");
        el.broadcastForm.reset();
        await loadDashboard();
      } catch (error) {
        setFeedback(error.message || "Gagal menyimpan broadcast.", "error");
      }
    }

    async function logout() {
      try {
        await postJson({ action: "logout" });
      } catch (error) {
        alert("Sesi lokal dihapus. Jika layanan bermasalah, sesi server akan kedaluwarsa otomatis.");
      } finally {
        localStorage.removeItem("billing_session");
        window.location.href = "index.html";
      }
    }

    el.broadcastForm.addEventListener("submit", handleBroadcast);
    el.refreshButton.addEventListener("click", loadDashboard);
    el.logoutButton.addEventListener("click", logout);

    if (session && session.role === "admin" && session.token) loadDashboard();
  
    // ---- Tab switching ----
    const tabBtns = document.querySelectorAll(".tab-btn");
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        tabBtns.forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("panel" + btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1)).classList.add("active");
        if (btn.dataset.tab === "dashboard") renderCharts();
        if (btn.dataset.tab === "paket") muatPaket(paket.select.value);
      });
    });

    // ---- Charts ----
    let chartStatus = null, chartBayar = null, chartPendapatan = null;
    async function renderCharts() {
      try {
        const result = await postJson({ action: "dashboardAdmin" });
        const data = result.data || {};
        const pelanggan = data.pelanggan || [];
        const aktif = pelanggan.filter((p) => String(p.statusSistem).toUpperCase() === "AKTIF").length;
        const isolir = pelanggan.length - aktif;
        const lunas = pelanggan.filter((p) => String(p.statusPembayaran).toUpperCase() === "LUNAS").length;
        const belum = pelanggan.length - lunas;

        const ctx1 = document.getElementById("chartStatus");
        if (ctx1) {
          if (chartStatus) chartStatus.destroy();
          chartStatus = new Chart(ctx1, {
            type: "doughnut",
            data: { labels: ["Aktif", "Terisolir"], datasets: [{ data: [aktif, isolir], backgroundColor: ["#22a06b", "#f5a623"], borderWidth: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "bottom" } } }
          });
        }
        const ctx2 = document.getElementById("chartBayar");
        if (ctx2) {
          if (chartBayar) chartBayar.destroy();
          chartBayar = new Chart(ctx2, {
            type: "doughnut",
            data: { labels: ["Lunas", "Belum Bayar"], datasets: [{ data: [lunas, belum], backgroundColor: ["#3763EB", "#e5484d"], borderWidth: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "bottom" } } }
          });
        }

        // Pendapatan bulanan dari riwayat pembayaran SETTLEMENT
        const riwayat = await (async () => {
          const res = await fetch(API_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "kelolaPelanggan", mode: "pendapatan", token: session.token }) });
          const r = await res.json();
          return r.success ? (r.data || []) : [];
        })();
        const bulanMap = {};
        const now = new Date();
        const labels = [], keys = [];
        for (let i = 5; i >= 0; i--) {
          const d0 = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = d0.getFullYear() + "-" + String(d0.getMonth() + 1).padStart(2, "0");
          keys.push(key);
          labels.push(d0.toLocaleDateString("id-ID", { month: "short", year: "2-digit" }));
          bulanMap[key] = 0;
        }
        (riwayat || []).forEach((row) => {
          const tgl = row.tgl || "";
          const key = String(tgl).slice(0, 7);
          if (key in bulanMap) bulanMap[key] += Number(row.nominal || 0);
        });
        const ctx3 = document.getElementById("chartPendapatan");
        if (ctx3) {
          if (chartPendapatan) chartPendapatan.destroy();
          chartPendapatan = new Chart(ctx3, {
            type: "bar",
            data: { labels, datasets: [{ label: "Pendapatan", data: keys.map((k) => bulanMap[k]), backgroundColor: "#3763EB", borderRadius: 8, maxBarThickness: 46 }] },
            options: { responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => formatCurrency(c.parsed.y) } } },
              scales: { y: { ticks: { callback: (v) => "Rp" + (v >= 1000000 ? (v / 1000000) + "jt" : v >= 1000 ? (v / 1000) + "rb" : v) } } } }
          });
        }
      } catch (error) { console.error("chart:", error); }
    }
    renderCharts();

    // ---- Kelola Akun Pelanggan (CRUD) ----
    const crud = {
      section: document.getElementById("crudSection"),
      tableBody: document.getElementById("crudTableBody"),
      btnTambah: document.getElementById("btnTambahPelanggan"),
      dialog: document.getElementById("crudDialog"),
      form: document.getElementById("crudForm"),
      title: document.getElementById("crudTitle"),
      id: document.getElementById("crudId"),
      nama: document.getElementById("crudNama"),
      paket: document.getElementById("crudPaket"),
      harga: document.getElementById("crudHarga"),
      password: document.getElementById("crudPassword"),
      wa: document.getElementById("crudWa"),
      status: document.getElementById("crudStatus"),
      batal: document.getElementById("crudBatal"),
      feedback: document.getElementById("crudFeedback"),
    };
    let crudMode = "create"; // "create" | "edit"

    async function crudCall(payload) {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, action: "kelolaPelanggan", token: session.token })
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.message || "Permintaan gagal.");
      return result.data;
    }

    function crudSetFeedback(message, type) {
      crud.feedback.textContent = message || "";
      crud.feedback.className = "feedback " + (type || "");
    }

    async function muatCrud() {
      try {
        const data = await crudCall({ mode: "list" });
        const items = data.pelanggan || [];
        if (!items.length) {
          crud.tableBody.innerHTML = '<tr><td colspan="8" class="empty-state">Belum ada pelanggan.</td></tr>';
          return;
        }
        crud.tableBody.innerHTML = items.map((c) => `
          <tr>
            <td><strong>${escapeHtml(c.id)}</strong></td>
            <td>${escapeHtml(c.nama)}</td>
            <td>${escapeHtml(c.paket)}</td>
            <td>${formatCurrency(c.harga)}</td>
            <td><span class="pill ${String(c.statusSistem).toUpperCase() === "AKTIF" ? "active" : "isolated"}">${escapeHtml(c.statusSistem)}</span></td>
            <td><span class="pill ${payPillClass(c.statusPembayaran)}">${escapeHtml(c.statusPembayaran || "-")}</span></td>
            <td>${escapeHtml(c.noWhatsApp || "-")}</td>
            <td class="crud-row-actions">
              <button type="button" class="crud-btn-edit" data-edit="${escapeHtml(c.id)}">Edit</button>
              <button type="button" class="crud-btn-del" data-del="${escapeHtml(c.id)}" data-nama="${escapeHtml(c.nama)}">Hapus</button>
            </td>
          </tr>`).join("");
      } catch (error) {
        crud.tableBody.innerHTML = `<tr><td colspan="8" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
      }
    }

    function bukaDialog(mode, customer) {
      crudMode = mode;
      crud.title.textContent = mode === "create" ? "Tambah Pelanggan" : "Edit Pelanggan: " + customer.id;
      crud.id.value = customer ? customer.id : "";
      crud.id.disabled = mode === "edit";
      crud.nama.value = customer ? customer.nama : "";
      isiDropdownPaket(customer ? customer.paket : "");
      if (customer) crud.harga.value = customer.harga;
      crud.password.value = "";
      crud.password.required = mode === "create";
      crud.password.placeholder = mode === "edit" ? "(kosongkan bila tidak diganti)" : "";
      crud.wa.value = customer ? (customer.noWhatsApp || "") : "";
      crud.status.value = customer ? (customer.statusSistem || "AKTIF") : "AKTIF";
      crudSetFeedback("", "");
      crud.dialog.showModal();
    }

    crud.btnTambah.addEventListener("click", () => bukaDialog("create", null));
    crud.batal.addEventListener("click", () => crud.dialog.close());

    crud.tableBody.addEventListener("click", async (event) => {
      const editBtn = event.target.closest("[data-edit]");
      const delBtn = event.target.closest("[data-del]");
      if (editBtn) {
        try {
          const data = await crudCall({ mode: "list" });
          const customer = (data.pelanggan || []).find((c) => c.id === editBtn.dataset.edit);
          if (customer) bukaDialog("edit", customer);
        } catch (error) { alert(error.message); }
      }
      if (delBtn) {
        if (!confirm(`Hapus akun ${delBtn.dataset.del} (${delBtn.dataset.nama})? Riwayat tagihannya juga akan dihapus.`)) return;
        try {
          await crudCall({ mode: "delete", id: delBtn.dataset.del });
          await muatCrud();
          await loadDashboard();
        } catch (error) { alert(error.message); }
      }
    });

    crud.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        mode: crudMode,
        id: crud.id.value.trim(),
        nama: crud.nama.value.trim(),
        paket: crud.paket.value.trim(),
        harga: Number(crud.harga.value),
        noWhatsApp: crud.wa.value.trim(),
        statusSistem: crud.status.value,
      };
      if (crudMode === "create" || crud.password.value.trim() !== "") payload.password = crud.password.value;
      const btn = document.getElementById("crudSimpan");
      btn.disabled = true;
      try {
        await crudCall(payload);
        crud.dialog.close();
        await muatCrud();
        await loadDashboard();
      } catch (error) {
        crudSetFeedback(error.message, "error");
      } finally { btn.disabled = false; }
    });

    muatCrud();

    // ---- Kelola Paket ----
    let daftarPaket = [];
    const paket = {
      tableBody: document.getElementById("paketTableBody"),
      btnTambah: document.getElementById("btnTambahPaket"),
      dialog: document.getElementById("paketDialog"),
      form: document.getElementById("paketForm"),
      title: document.getElementById("paketTitle"),
      nama: document.getElementById("paketNama"),
      nominal: document.getElementById("paketNominal"),
      feedback: document.getElementById("paketDialogFeedback"),
      panelFeedback: document.getElementById("paketFeedback"),
      select: document.getElementById("crudPaket"),
      harga: document.getElementById("crudHarga"),
    };
    let paketMode = "create";
    let paketEditId = "";

    function paketFeedback(message, type) {
      paket.feedback.textContent = message || "";
      paket.feedback.className = "feedback " + (type || "");
      if (paket.panelFeedback) { paket.panelFeedback.textContent = message || ""; paket.panelFeedback.className = "feedback " + (type || ""); }
    }

    function paketCall(payload) {
      return fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, action: "kelolaPaket", token: session.token })
      }).then((r) => r.json()).then((result) => {
        if (!result.success) throw new Error(result.message || "Permintaan gagal.");
        return result.data;
      });
    }

    function isiDropdownPaket(terpilih) {
      const opts = daftarPaket.map((p) =>
        `<option value="${escapeHtml(p.nama)}" data-nominal="${p.nominal}" ${p.nama === terpilih ? "selected" : ""}>${escapeHtml(p.nama)}</option>`).join("");
      paket.select.innerHTML = opts || '<option value="">(belum ada paket)</option>';
      const sel = paket.select.selectedOptions[0];
      if (sel) paket.harga.value = sel.dataset.nominal || "";
    }

    paket.select.addEventListener("change", () => {
      const sel = paket.select.selectedOptions[0];
      if (sel) paket.harga.value = sel.dataset.nominal || "";
    });

    async function muatPaket(terpilih) {
      try {
        const data = await paketCall({ mode: "list" });
        daftarPaket = data.paket || [];
        isiDropdownPaket(terpilih);
        paket.tableBody.innerHTML = daftarPaket.map((p) => `
          <tr>
            <td><strong>${escapeHtml(p.nama)}</strong></td>
            <td>${formatCurrency(p.nominal)}</td>
            <td class="crud-row-actions">
              <button type="button" class="crud-btn-edit" data-pedit="${escapeHtml(p.id)}" data-pnama="${escapeHtml(p.nama)}" data-pnominal="${p.nominal}">Edit</button>
              <button type="button" class="crud-btn-del" data-pdel="${escapeHtml(p.id)}" data-pnama="${escapeHtml(p.nama)}">Hapus</button>
            </td>
          </tr>`).join("");
      } catch (error) {
        paket.tableBody.innerHTML = `<tr><td colspan="3" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
      }
    }

    paket.btnTambah.addEventListener("click", () => {
      paketMode = "create"; paketEditId = "";
      paket.title.textContent = "Tambah Paket";
      paket.nama.value = ""; paket.nominal.value = "";
      paketFeedback("", "");
      paket.dialog.showModal();
    });

    paket.tableBody.addEventListener("click", async (event) => {
      const eBtn = event.target.closest("[data-pedit]");
      const dBtn = event.target.closest("[data-pdel]");
      if (eBtn) {
        paketMode = "update"; paketEditId = eBtn.dataset.pedit;
        paket.title.textContent = "Edit Paket";
        paket.nama.value = eBtn.dataset.pnama;
        paket.nominal.value = eBtn.dataset.pnominal;
        paketFeedback("", "");
        paket.dialog.showModal();
      }
      if (dBtn) {
        if (!confirm(`Hapus paket ${dBtn.dataset.pnama}?`)) return;
        try { await paketCall({ mode: "delete", id: dBtn.dataset.pdel }); await muatPaket(paket.select.value); }
        catch (error) { paketFeedback(error.message, "error"); }
      }
    });

    paket.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const btn = document.getElementById("paketSimpan");
      btn.disabled = true;
      try {
        if (paketMode === "create") {
          await paketCall({ mode: "create", nama: paket.nama.value.trim(), nominal: Number(paket.nominal.value) });
        } else {
          await paketCall({ mode: "update", id: paketEditId, nama: paket.nama.value.trim(), nominal: Number(paket.nominal.value) });
        }
        paket.dialog.close();
        await muatPaket(paket.select.value);
      } catch (error) {
        paketFeedback(error.message, "error");
      } finally { btn.disabled = false; }
    });

    paket.batal.addEventListener("click", () => paket.dialog.close());

    // Muat paket saat init (untuk dropdown CRUD pelanggan)
    muatPaket(paket.select.value);
