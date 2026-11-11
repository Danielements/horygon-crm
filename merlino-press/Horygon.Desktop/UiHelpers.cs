using System.Globalization;

using System.Windows;

using System.Windows.Controls;

using System.Windows.Data;

using System.Windows.Media;

namespace Horygon.Desktop;

public sealed class NavIcon : IValueConverter

{

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value?.ToString() switch

    {

        "Dashboard" => "\uE80F", "Tabellone task" => "\uE7C1", "Roadmap" => "\uE8A5", "Posta in arrivo" => "\uE715", "Priorità AI" => "\uE734", "Attività" => "\uE73A", "Ordini" => "\uE7BF", "Workflow" => "\uE8AB", "Approvazioni" => "\uE930", "Ricerca" => "\uE721", "Report" => "\uE9D9", _ => "\uE713"

    };

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;

}

public sealed class PageVisibility : IValueConverter

{

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => (parameter?.ToString() ?? "").Split('|').Contains(value?.ToString()) ? Visibility.Visible : Visibility.Collapsed;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;

}

public sealed class InverseBool : IValueConverter

{

    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) => value is not true;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;

}

public static class SecretBinding

{

    public static readonly DependencyProperty EnabledProperty = DependencyProperty.RegisterAttached("Enabled", typeof(bool), typeof(SecretBinding), new PropertyMetadata(false, (obj, args) => { if (obj is PasswordBox box) { box.PasswordChanged -= PasswordChanged; if ((bool)args.NewValue) box.PasswordChanged += PasswordChanged; } }));

    public static bool GetEnabled(DependencyObject obj) => (bool)obj.GetValue(EnabledProperty);

    public static void SetEnabled(DependencyObject obj, bool value) => obj.SetValue(EnabledProperty, value);

    public static readonly DependencyProperty ValueProperty = DependencyProperty.RegisterAttached("Value", typeof(string), typeof(SecretBinding), new FrameworkPropertyMetadata("", FrameworkPropertyMetadataOptions.BindsTwoWayByDefault, Changed));

    public static string GetValue(DependencyObject obj) => (string)obj.GetValue(ValueProperty);

    public static void SetValue(DependencyObject obj, string value) => obj.SetValue(ValueProperty, value);

    private static void Changed(DependencyObject obj, DependencyPropertyChangedEventArgs args)

    {

        if (obj is not PasswordBox box) return;

        box.PasswordChanged -= PasswordChanged;

        if (box.Password != (string)args.NewValue) box.Password = (string)args.NewValue;

        box.PasswordChanged += PasswordChanged;

    }

    private static void PasswordChanged(object sender, RoutedEventArgs args) => ((PasswordBox)sender).SetCurrentValue(ValueProperty, ((PasswordBox)sender).Password);

}

public static class Theme

{

    public static void Apply(bool light)

    {

        var colors = light ? new[] { "#F2F5FA", "#E7EDF5", "#FFFFFF", "#172033", "#52627A", "#CBD5E1" } : new[] { "#0B1120", "#111827", "#192334", "#F8FAFC", "#94A3B8", "#263449" };

        var keys = new[] { "Background", "Sidebar", "Surface", "Primary", "Secondary", "Line" };

        for (var i = 0; i < keys.Length; i++) Application.Current.Resources[keys[i]] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(colors[i]));

    }

}

