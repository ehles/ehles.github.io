$('.close').click(function(){
  $('.card').slideToggle();
});

$('.final').click(function(){
  $('.middle').slideToggle('slow');
  $('.reply').toggle();
  $('.text').text(function(i, v){
               return v === 'See Post' ? 'Collapse' : 'See Post'
  });
});