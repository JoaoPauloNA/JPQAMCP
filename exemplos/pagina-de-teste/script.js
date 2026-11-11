(function () {
  var form = document.getElementById('form-cadastro');
  if (!form) return;

  // ---------- Máscaras ----------
  function digits(v) { return v.replace(/\D/g, ''); }
  var masks = {
    cpf: function (v) {
      v = digits(v).slice(0, 11);
      return v.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    },
    phone: function (v) {
      v = digits(v).slice(0, 11);
      if (v.length > 10) return v.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
      if (v.length > 6) return v.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
      if (v.length > 2) return v.replace(/(\d{2})(\d{0,5})/, '($1) $2');
      return v;
    },
    cep: function (v) {
      v = digits(v).slice(0, 8);
      return v.replace(/(\d{5})(\d{1,3})/, '$1-$2');
    },
    money: function (v) {
      v = digits(v);
      if (!v) return '';
      var n = (parseInt(v, 10) / 100).toFixed(2).split('.');
      n[0] = n[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return 'R$ ' + n[0] + ',' + n[1];
    }
  };
  form.querySelectorAll('[data-mask]').forEach(function (el) {
    el.addEventListener('input', function () { el.value = masks[el.dataset.mask](el.value); });
  });

  // ---------- Contadores / saídas ----------
  var bio = document.getElementById('bio');
  bio.addEventListener('input', function () { document.getElementById('bio-count').textContent = bio.value.length; });
  var nivel = document.getElementById('nivel');
  nivel.addEventListener('input', function () { document.getElementById('nivel-out').textContent = nivel.value; });

  // ---------- Validação ----------
  function validCPF(c) {
    c = digits(c);
    if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
    for (var t = 9; t < 11; t++) {
      var s = 0;
      for (var i = 0; i < t; i++) s += parseInt(c[i], 10) * (t + 1 - i);
      var d = ((s * 10) % 11) % 10;
      if (d !== parseInt(c[t], 10)) return false;
    }
    return true;
  }
  function age(dateStr) {
    var b = new Date(dateStr), n = new Date();
    var a = n.getFullYear() - b.getFullYear();
    var m = n.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
    return a;
  }
  function val(name) { return (form.elements[name] && form.elements[name].value || '').trim(); }

  function validate() {
    var e = {};
    if (val('nome').length < 3) e.nome = 'Informe o nome completo (mín. 3 caracteres).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('email'))) e.email = 'E-mail inválido.';
    if (digits(val('telefone')).length < 10) e.telefone = 'Telefone inválido.';
    if (!validCPF(val('cpf'))) e.cpf = 'CPF inválido.';
    if (!val('nascimento')) e.nascimento = 'Informe a data de nascimento.';
    else if (age(val('nascimento')) < 18) e.nascimento = 'É preciso ter 18 anos ou mais.';
    if (!form.querySelector('input[name=genero]:checked')) e.genero = 'Selecione uma opção.';
    if (!/^[a-z0-9_]{4,16}$/.test(val('usuario'))) e.usuario = 'Usuário inválido (4–16: a-z, 0-9, _).';
    if (val('site') && !/^https?:\/\/[^\s.]+\.[^\s]+$/.test(val('site'))) e.site = 'URL inválida (use http:// ou https://).';
    var s = form.elements.senha.value;
    if (!(s.length >= 8 && /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s))) e.senha = 'Senha fraca: mín. 8, com maiúscula, minúscula e número.';
    if (form.elements.senha2.value !== s || !s) e.senha2 = 'As senhas não coincidem.';
    if (digits(val('cep')).length !== 8) e.cep = 'CEP inválido.';
    var num = val('numero');
    if (num && (parseInt(num, 10) < 1 || parseInt(num, 10) > 99999)) e.numero = 'Número entre 1 e 99999.';
    if (!val('pais')) e.pais = 'Selecione o país.';
    var pets = val('pets');
    if (pets !== '' && (parseInt(pets, 10) < 0 || parseInt(pets, 10) > 20)) e.pets = 'Entre 0 e 20.';
    if (!form.elements.termos.checked) e.termos = 'É necessário aceitar os termos.';
    return e;
  }

  function showErrors(errs) {
    form.querySelectorAll('[data-error-for]').forEach(function (s) { s.textContent = errs[s.dataset.errorFor] || ''; });
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      el.classList.toggle('invalid', !!errs[el.name]);
    });
  }

  // ---------- Envio ----------
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var errs = validate();
    showErrors(errs);
    var keys = Object.keys(errs);
    var box = document.getElementById('resultado');
    if (keys.length) {
      box.style.display = 'none';
      var first = form.querySelector('[name=' + keys[0] + ']');
      if (first) first.focus();
      return;
    }
    var data = {};
    new FormData(form).forEach(function (v, k) {
      if (v instanceof File) v = v.name ? v.name + ' (' + v.size + ' bytes)' : '';
      if (k === 'senha' || k === 'senha2') v = '********';
      if (data[k] !== undefined) {
        if (!Array.isArray(data[k])) data[k] = [data[k]];
        data[k].push(v);
      } else data[k] = v;
    });
    document.getElementById('resultado-json').textContent = JSON.stringify(data, null, 2);
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth' });
  });

  form.addEventListener('reset', function () {
    setTimeout(function () {
      showErrors({});
      document.getElementById('resultado').style.display = 'none';
      document.getElementById('bio-count').textContent = '0';
      document.getElementById('nivel-out').textContent = '5';
    }, 0);
  });
})();
