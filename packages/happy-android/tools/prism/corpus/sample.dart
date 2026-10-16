import 'dart:async';
/// Doc comment
class Counter extends ChangeNotifier {
  int _value = 0;
  final String label = 'count';
  Future<void> increment() async {
    _value += 1;
    print('Value: $_value ${label.toUpperCase()}');
    notifyListeners();
  }
}
